import type { Logger } from "../tracing/logger";
import { EMPTY_HASH } from "../utils/hash";
import { CoveredValues } from "../utils/data-structures/min-covered";
import { awaitAll } from "../utils/await-all";
import { removeFromArray } from "../utils/remove-from-array";

export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface DocumentMetadata {
    documentId: DocumentId;
    parentVersionId: VaultUpdateId;
    hash: string;
    remoteRelativePath?: RelativePath;
}

export interface StoredDocumentMetadata {
    relativePath: RelativePath;
    documentId: DocumentId;
    parentVersionId: VaultUpdateId;
    remoteRelativePath?: RelativePath;
    hash: string;
}

export interface StoredDatabase {
    documents: StoredDocumentMetadata[];
    lastSeenUpdateId: VaultUpdateId | undefined;
}

/**
 * Represents a document in the database.
 *
 * It is mutable and its content should always represent the latest
 * state of the document on disk based on the update events we have seen.
 */
export interface DocumentRecord {
    relativePath: RelativePath;
    metadata: DocumentMetadata | undefined;
    isDeleted: boolean;
    updates: Promise<unknown>[];
    parallelVersion: number;
}

export class Database {
    private documents: DocumentRecord[];
    private lastSeenUpdateIds: CoveredValues;

    public constructor(
        private readonly logger: Logger,
        initialState: Partial<StoredDatabase> | undefined,
        private readonly saveData: (data: StoredDatabase) => Promise<void>
    ) {
        initialState ??= {};

        this.documents =
            initialState.documents?.map(({ relativePath, ...metadata }) => ({
                relativePath,
                metadata,
                isDeleted: false,
                updates: [],
                parallelVersion: 0
            })) ?? [];

        this.ensureConsistency();
        this.logger.debug(`Loaded ${this.documents.length} documents`);

        const { lastSeenUpdateId } = initialState;
        this.logger.debug(`Loaded last seen update id: ${lastSeenUpdateId}`);
        this.lastSeenUpdateIds = new CoveredValues(
            Math.max(0, lastSeenUpdateId ?? 0) // the first updateId will be 1 which is the first integer after -1
        );

        this.documents.forEach((doc) => {
            this.lastSeenUpdateIds.add(doc.metadata?.parentVersionId);
        });
    }

    public get length(): number {
        return this.documents.length;
    }

    public get resolvedDocuments(): DocumentRecord[] {
        const paths = new Map<string, DocumentRecord[]>();
        this.documents
            // eslint-disable-next-line no-restricted-syntax -- Type narrowing, not removing a specific item
            .filter(({ metadata }) => metadata !== undefined)
            .forEach((record) =>
                paths.set(record.relativePath, [
                    record,
                    ...(paths.get(record.relativePath) ?? [])
                ])
            );

        return Array.from(paths.values()).map((records) => {
            records.sort(
                (a, b) => b.parallelVersion - a.parallelVersion // descending
            );

            if (
                records.length > 1 &&
                records.some((current, i) =>
                    i === 0
                        ? false
                        : records[i - 1].parallelVersion ===
                        current.parallelVersion
                )
            ) {
                throw new Error(
                    `Multiple documents with the same parallel version and path at ${records[0].relativePath}`
                );
            }
            return records[0];
        });
    }

    public updateDocumentMetadata(
        metadata: {
            documentId: DocumentId;
            parentVersionId: VaultUpdateId;
            hash: string;
            remoteRelativePath: RelativePath;
        },
        toUpdate: DocumentRecord
    ): void {
        if (!this.documents.includes(toUpdate)) {
            throw new Error("Document not found in database");
        }

        toUpdate.metadata = metadata;

        this.saveInTheBackground();
    }

    public removeDocumentPromise(promise: Promise<unknown>): void {
        const entry = this.documents.find(({ updates }) =>
            updates.includes(promise)
        );

        if (entry === undefined) {
            // This method should be idempotent and tolerant of
            // stragglers calling it after the databse has been reset.
            return;
        }

        removeFromArray(entry.updates, promise);
        // No need to save as Promises don't get serialized
    }

    public removeDocument(find: DocumentRecord): void {
        removeFromArray(this.documents, find);
        this.saveInTheBackground();
    }

    public getLatestDocumentByRelativePath(
        find: RelativePath
    ): DocumentRecord | undefined {
        const candidates = this.documents.filter(
            ({ relativePath }) => relativePath === find
        );
        candidates.sort((a, b) => b.parallelVersion - a.parallelVersion); // descending
        return candidates[0];
    }

    public async getResolvedDocumentByRelativePath(
        relativePath: RelativePath,
        promise: Promise<unknown>
    ): Promise<DocumentRecord> {
        const entry = this.getLatestDocumentByRelativePath(relativePath);

        if (entry === undefined) {
            throw new Error(
                `Document not found by relative path in getResolvedDocumentByRelativePath: ${relativePath}, ${JSON.stringify(
                    this.documents,
                    null,
                    2
                )}`
            );
        }

        const currentPromises = entry.updates;
        entry.updates = [...currentPromises, promise];
        await awaitAll(currentPromises);

        return entry;
    }

    public createNewPendingDocument(
        relativePath: RelativePath,
        promise: Promise<unknown>
    ): DocumentRecord {
        this.logger.debug(`Creating new pending document: ${relativePath}`);
        const previousEntry =
            this.getLatestDocumentByRelativePath(relativePath);

        const entry = {
            relativePath,
            metadata: undefined,
            isDeleted: false,
            updates: [promise],
            parallelVersion:
                previousEntry?.parallelVersion === undefined
                    ? 0
                    : previousEntry.parallelVersion + 1
        };

        this.documents.push(entry);
        this.saveInTheBackground();

        return entry;
    }

    public createNewEmptyDocument(
        documentId: DocumentId,
        parentVersionId: VaultUpdateId,
        relativePath: RelativePath
    ): DocumentRecord {
        const entry = {
            relativePath,
            metadata: {
                documentId,
                parentVersionId,
                hash: EMPTY_HASH,
                remoteRelativePath: relativePath
            },
            isDeleted: false,
            updates: [],
            parallelVersion: 0
        };

        this.documents.push(entry);
        this.saveInTheBackground();

        return entry;
    }

    public getDocumentByDocumentId(
        find: DocumentId
    ): DocumentRecord | undefined {
        return this.documents.find(
            ({ metadata }) => metadata?.documentId === find
        );
    }

    public move(
        oldRelativePath: RelativePath,
        newRelativePath: RelativePath
    ): void {
        const oldDocument =
            this.getLatestDocumentByRelativePath(oldRelativePath);

        if (oldDocument === undefined) {
            return;
        }

        const newDocument =
            this.getLatestDocumentByRelativePath(newRelativePath);
        if (newDocument?.isDeleted === false) {
            throw new Error(
                `Document already exists at new location: ${newRelativePath}`
            );
        }

        oldDocument.relativePath = newRelativePath;
        // We might be in a strange state where the target of the move has just got deleted,
        // however, its metadata might already have a bunch of updates queued up for
        // the document at the new location. We need to keep these updates.
        oldDocument.parallelVersion =
            newDocument !== undefined ? newDocument.parallelVersion + 1 : 0;

        this.saveInTheBackground();
    }

    public delete(relativePath: RelativePath): void {
        const candidate = this.getLatestDocumentByRelativePath(relativePath);
        if (candidate === undefined) {
            throw new Error(
                `Document not found by relative path in delete: ${relativePath}, ${JSON.stringify(
                    this.documents,
                    null,
                    2
                )}`
            );
        }
        candidate.isDeleted = true;
    }

    public getLastSeenUpdateId(): VaultUpdateId {
        return this.lastSeenUpdateIds.min;
    }

    public addSeenUpdateId(value: number): void {
        const previousMin = this.lastSeenUpdateIds.min;
        this.lastSeenUpdateIds.add(value);
        if (previousMin !== this.lastSeenUpdateIds.min) {
            this.saveInTheBackground();
        }
    }

    public setLastSeenUpdateId(value: number): void {
        this.lastSeenUpdateIds.min = value;
        this.saveInTheBackground();
    }

    public reset(): void {
        this.documents = [];
        this.lastSeenUpdateIds = new CoveredValues(
            0 // the first updateId will be 1 which is the first integer after -1
        );
        this.saveInTheBackground();
    }

    public async save(): Promise<void> {
        return this.saveData({
            documents: this.resolvedDocuments.map(
                ({ relativePath, metadata }) => ({
                    relativePath,
                    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
                    ...metadata! // `resolvedDocuments` only returns docs with metadata set
                })
            ),
            lastSeenUpdateId: this.lastSeenUpdateIds.min
        });
    }

    private ensureConsistency(): void {
        const idToPath = new Map<string, string[]>();

        this.resolvedDocuments.forEach(({ relativePath, metadata }) => {
            if (metadata === undefined) {
                return;
            }
            idToPath.set(metadata.documentId, [
                ...(idToPath.get(metadata.documentId) ?? []),
                relativePath
            ]);
        });

        const duplicates = Array.from(idToPath.entries())
            .filter(([_, paths]) => paths.length > 1)
            .map(([id, paths]) => {
                let details = "";
                for (const path of paths) {
                    const doc = this.getLatestDocumentByRelativePath(path);
                    details += `\n- ${JSON.stringify(doc, null, 2)}`;
                }
                return `${id} (${paths.join(", ")}): ${details}`;
            });

        if (duplicates.length > 0) {
            throw new Error(
                "Document IDs are not unique, found duplicates: " +
                duplicates.join("; ")
            );
        }
    }

    private saveInTheBackground(): void {
        this.ensureConsistency();
        void this.save().catch((error: unknown) => {
            this.logger.error(`Error saving data: ${error}`);
        });
    }
}
