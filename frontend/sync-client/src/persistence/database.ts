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

export interface StoredPendingDocument {
    relativePath: RelativePath;
    idempotencyKey: string;
    originalCreationPath: RelativePath;
}

export interface StoredDatabase {
    documents: StoredDocumentMetadata[];
    pendingDocuments?: StoredPendingDocument[];
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
    parallelVersion: number;
    /** The path when this pending document was first created locally.
     *  Survives renames so we can match it against server responses
     *  when a create request succeeded but the response was lost. */
    originalCreationPath?: RelativePath;
    idempotencyKey?: string;
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

        const validDocuments = (initialState.documents ?? []).filter(
            (doc) =>
                this.validateStoredField(doc, "relativePath", "string") &&
                this.validateStoredField(doc, "documentId", "string") &&
                this.validateStoredField(doc, "parentVersionId", "number")
        );

        this.documents = validDocuments.map(
            ({ relativePath, ...metadata }) => ({
                relativePath,
                metadata,
                isDeleted: false,
                parallelVersion: 0
            })
        );

        const validPendingDocuments = (
            initialState.pendingDocuments ?? []
        ).filter(
            (doc) =>
                this.validateStoredField(doc, "relativePath", "string") &&
                this.validateStoredField(doc, "idempotencyKey", "string")
        );

        for (const pending of validPendingDocuments) {
            const existing = this.getLatestDocumentByRelativePath(
                pending.relativePath
            );
            this.documents.push({
                relativePath: pending.relativePath,
                metadata: undefined,
                isDeleted: false,
                parallelVersion:
                    existing !== undefined
                        ? existing.parallelVersion + 1
                        : 0,
                originalCreationPath: pending.originalCreationPath,
                idempotencyKey: pending.idempotencyKey
            });
        }

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

    private validateStoredField(
        doc: object,
        field: string,
        expectedType: "string" | "number"
    ): boolean {
        const value = (doc as Record<string, unknown>)[field];
        if (
            typeof value !== expectedType ||
            (expectedType === "string" && !value) ||
            (expectedType === "number" && isNaN(value as number))
        ) {
            this.logger.warn(
                `Skipping stored document with invalid ${field}: ${JSON.stringify(doc)}`
            );
            return false;
        }
        return true;
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

    public get pendingDocuments(): DocumentRecord[] {
        return this.documents.filter(
            (doc) => doc.metadata === undefined && !doc.isDeleted
        );
    }

    public updateDocumentMetadata(
        metadata: {
            documentId: DocumentId;
            parentVersionId: VaultUpdateId;
            hash: string;
            remoteRelativePath: RelativePath;
        },
        target: DocumentRecord
    ): void {
        if (!this.documents.includes(target)) {
            throw new Error("Document not found in database");
        }

        this.logger.debug(
            `Updating document metadata for ${target.relativePath} from ${JSON.stringify(
                target.metadata,
                null,
                2
            )} to ${JSON.stringify(metadata, null, 2)}`
        );

        target.metadata = metadata;

        this.saveInTheBackground();
    }

    public getLatestDocumentByRelativePath(
        target: RelativePath
    ): DocumentRecord | undefined {
        const candidates = this.documents.filter(
            ({ relativePath }) => relativePath === target
        );
        candidates.sort((a, b) => b.parallelVersion - a.parallelVersion); // descending
        return candidates[0];
    }

    public createNewPendingDocument(
        relativePath: RelativePath
    ): DocumentRecord {
        this.logger.debug(`Creating new pending document: ${relativePath}`);
        const previousEntry =
            this.getLatestDocumentByRelativePath(relativePath);

        const entry: DocumentRecord = {
            relativePath,
            metadata: undefined,
            isDeleted: false,
            parallelVersion:
                previousEntry?.parallelVersion === undefined
                    ? 0
                    : previousEntry.parallelVersion + 1,
            originalCreationPath: relativePath,
            idempotencyKey: crypto.randomUUID()
        };

        this.documents.push(entry);

        // Save without consistency check — pending docs can't violate
        // the documentId uniqueness invariant since they have no metadata.
        void this.save().catch((error: unknown) => {
            this.logger.error(`Error saving data: ${error}`);
        });

        return entry;
    }

    public getDocumentByDocumentId(
        target: DocumentId
    ): DocumentRecord | undefined {
        return this.documents.find(
            ({ metadata }) => metadata?.documentId === target
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
            return;
        }
        candidate.isDeleted = true;
    }

    public removeDocument(target: DocumentRecord): void {
        removeFromArray(this.documents, target);
        this.saveInTheBackground();
    }

    public containsDocument(target: DocumentRecord): boolean {
        return this.documents.includes(target);
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
                    ...metadata! // filtered to only docs with metadata set
                })
            ),
            pendingDocuments: this.pendingDocuments.map(
                ({ relativePath, idempotencyKey, originalCreationPath }) => ({
                    relativePath,
                    idempotencyKey: idempotencyKey!,
                    originalCreationPath: originalCreationPath!
                })
            ),
            lastSeenUpdateId: this.lastSeenUpdateIds.min
        });
    }

    private ensureConsistency(): void {
        // Check for duplicate documentIds across ALL documents with metadata,
        // not just the deduplicated resolvedDocuments view. A duplicate on a
        // lower-parallelVersion record would otherwise go undetected.
        const allWithMetadata = this.documents
            // eslint-disable-next-line no-restricted-syntax -- Type narrowing, not removing a specific item
            .filter((d) => d.metadata !== undefined);
        const documentIdSet = new Set<string>();
        for (const doc of allWithMetadata) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const docId = doc.metadata!.documentId;
            if (documentIdSet.has(docId)) {
                throw new Error(
                    `Duplicate documentId ${docId} found in database`
                );
            }
            documentIdSet.add(docId);
        }

        // Also check the deduplicated view for path-level invariants
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
