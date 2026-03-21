import type { Logger } from "../tracing/logger";
import { EMPTY_HASH } from "../utils/hash";
import { CoveredValues } from "../utils/data-structures/min-covered";
import type {
    StoredDatabase,
    StoredDocumentMetadata,
    StoredPendingDocument,
    VaultUpdateId,
    DocumentId,
    RelativePath
} from "./database";

// ---------------------------------------------------------------------------
// Document state types (discriminated union)
// ---------------------------------------------------------------------------

export interface PendingDocument {
    readonly state: "pending";
    relativePath: string;
    readonly idempotencyKey: string;
    readonly originalCreationPath: string;
}

export interface TrackedDocument {
    readonly state: "tracked";
    relativePath: string;
    documentId: string;
    serverVersion: number;
    localHash: string;
    remoteRelativePath: string;
    idempotencyKey?: string;
}

export interface DeletedLocallyDocument {
    readonly state: "deleted-locally";
    relativePath: string;
    readonly documentId: string;
    readonly serverVersion: number;
    readonly remoteRelativePath: string;
}

export type VirtualDocument =
    | PendingDocument
    | TrackedDocument
    | DeletedLocallyDocument;

// ---------------------------------------------------------------------------
// Reconciliation result
// ---------------------------------------------------------------------------

export interface ReconciliationResult {
    newFiles: string[];
    modifiedFiles: { path: string; documentId: string }[];
    missingFiles: VirtualDocument[];
    movedFiles: { document: TrackedDocument; newPath: string }[];
}

// ---------------------------------------------------------------------------
// VirtualFilesystem
// ---------------------------------------------------------------------------

export class VirtualFilesystem {
    /** One live document per path (pending or tracked, NOT deleted-locally). */
    private readonly pathIndex = new Map<string, VirtualDocument>();

    /** All documents that have a documentId (tracked + deleted-locally). */
    private readonly documentIdIndex = new Map<string, VirtualDocument>();

    /** Pending documents by idempotency key. */
    private readonly idempotencyKeyIndex = new Map<string, PendingDocument>();

    private lastSeenUpdateIds: CoveredValues;

    private pendingSave: Promise<void> = Promise.resolve();

    public constructor(
        private readonly logger: Logger,
        initialState: Partial<StoredDatabase> | undefined,
        private readonly saveData: (data: StoredDatabase) => Promise<void>
    ) {
        const state: Partial<StoredDatabase> = initialState ?? {};

        const validDocuments = (state.documents ?? []).filter(
            (doc) =>
                this.validateStoredField(doc, "relativePath", "string") &&
                this.validateStoredField(doc, "documentId", "string") &&
                this.validateStoredField(doc, "parentVersionId", "number")
        );

        for (const stored of validDocuments) {
            if (stored.isDeleted === true) {
                const doc: DeletedLocallyDocument = {
                    state: "deleted-locally",
                    relativePath: stored.relativePath,
                    documentId: stored.documentId,
                    serverVersion: stored.parentVersionId,
                    remoteRelativePath:
                        stored.remoteRelativePath ?? stored.relativePath
                };
                // deleted-locally docs go into documentIdIndex only
                this.documentIdIndex.set(doc.documentId, doc);
            } else {
                const doc: TrackedDocument = {
                    state: "tracked",
                    relativePath: stored.relativePath,
                    documentId: stored.documentId,
                    serverVersion: stored.parentVersionId,
                    localHash: stored.hash,
                    remoteRelativePath:
                        stored.remoteRelativePath ?? stored.relativePath
                };
                // If two stored documents have the same path, last one wins
                // (matches old behavior where highest parallelVersion wins)
                this.pathIndex.set(doc.relativePath, doc);
                this.documentIdIndex.set(doc.documentId, doc);
            }
        }

        const validPendingDocuments = (state.pendingDocuments ?? []).filter(
            (doc) =>
                this.validateStoredField(doc, "relativePath", "string") &&
                this.validateStoredField(doc, "idempotencyKey", "string")
        );

        for (const stored of validPendingDocuments) {
            // If a live doc already exists at this path, skip the pending one
            // only if the live doc is tracked (has metadata). If a pending doc
            // already exists, skip duplicates.
            const existing = this.pathIndex.get(stored.relativePath);
            if (existing?.state === "pending") {
                this.logger.debug(
                    `Skipping duplicate pending document at ${stored.relativePath}`
                );
                continue;
            }

            const doc: PendingDocument = {
                state: "pending",
                relativePath: stored.relativePath,
                idempotencyKey: stored.idempotencyKey,
                originalCreationPath:
                    stored.originalCreationPath ?? stored.relativePath
            };

            // A pending doc at a path where a tracked doc exists: the pending
            // doc takes precedence in pathIndex (mirrors old behavior where
            // pending has higher parallelVersion).
            this.pathIndex.set(doc.relativePath, doc);
            this.idempotencyKeyIndex.set(doc.idempotencyKey, doc);
        }

        this.ensureConsistency();

        const totalDocs =
            this.pathIndex.size + this.deletedLocallyDocuments().length;
        this.logger.debug(`Loaded ${totalDocs} documents`);

        const { lastSeenUpdateId } = state;
        this.logger.debug(`Loaded last seen update id: ${lastSeenUpdateId}`);
        this.lastSeenUpdateIds = new CoveredValues(
            Math.max(0, lastSeenUpdateId ?? 0)
        );

        // Seed CoveredValues with known server versions
        for (const doc of this.documentIdIndex.values()) {
            if (doc.state === "tracked") {
                this.lastSeenUpdateIds.add(doc.serverVersion);
            } else if (doc.state === "deleted-locally") {
                this.lastSeenUpdateIds.add(doc.serverVersion);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Validation helper
    // -----------------------------------------------------------------------

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

    // -----------------------------------------------------------------------
    // Queries
    // -----------------------------------------------------------------------

    public getByPath(path: string): VirtualDocument | undefined {
        return this.pathIndex.get(path);
    }

    public getByDocumentId(id: string): VirtualDocument | undefined {
        return this.documentIdIndex.get(id);
    }

    public getByIdempotencyKey(key: string): PendingDocument | undefined {
        return this.idempotencyKeyIndex.get(key);
    }

    public trackedDocuments(): TrackedDocument[] {
        const result: TrackedDocument[] = [];
        for (const doc of this.pathIndex.values()) {
            if (doc.state === "tracked") {
                result.push(doc);
            }
        }
        return result;
    }

    public pendingDocuments(): PendingDocument[] {
        const result: PendingDocument[] = [];
        for (const doc of this.pathIndex.values()) {
            if (doc.state === "pending") {
                result.push(doc);
            }
        }
        return result;
    }

    public deletedLocallyDocuments(): DeletedLocallyDocument[] {
        const result: DeletedLocallyDocument[] = [];
        for (const doc of this.documentIdIndex.values()) {
            if (doc.state === "deleted-locally") {
                result.push(doc);
            }
        }
        return result;
    }

    /** All live documents (pending + tracked) that occupy a path. */
    public allLiveDocuments(): VirtualDocument[] {
        return Array.from(this.pathIndex.values());
    }

    /** Total number of documents across all indexes (live + deleted-locally). */
    public get length(): number {
        // pathIndex has live docs (pending + tracked).
        // documentIdIndex has tracked + deleted-locally.
        // Tracked docs appear in both, so count:
        //   pending (pathIndex only) + tracked (both) + deleted-locally (documentIdIndex only)
        // = pathIndex.size + deletedLocally count
        let deletedCount = 0;
        for (const doc of this.documentIdIndex.values()) {
            if (doc.state === "deleted-locally") {
                deletedCount++;
            }
        }
        return this.pathIndex.size + deletedCount;
    }

    public contains(doc: VirtualDocument): boolean {
        switch (doc.state) {
            case "pending":
                return this.idempotencyKeyIndex.get(doc.idempotencyKey) === doc;
            case "tracked":
                return this.documentIdIndex.get(doc.documentId) === doc;
            case "deleted-locally":
                return this.documentIdIndex.get(doc.documentId) === doc;
        }
    }

    // -----------------------------------------------------------------------
    // Update ID tracking
    // -----------------------------------------------------------------------

    public getLastSeenUpdateId(): number {
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

    // -----------------------------------------------------------------------
    // Mutations
    // -----------------------------------------------------------------------

    /**
     * Create a pending document at the given path. If a pending document
     * already exists at the path, return it (idempotent). Generates a new
     * idempotency key via `crypto.randomUUID()`.
     *
     * Awaits save() so the idempotency key is persisted before any HTTP
     * request is sent.
     */
    public async createPending(path: string): Promise<PendingDocument> {
        this.logger.debug(`Creating new pending document: ${path}`);

        const existing = this.pathIndex.get(path);
        if (existing?.state === "pending") {
            this.logger.debug(
                `Pending document already exists at ${path}, reusing it`
            );
            return existing;
        }

        const doc: PendingDocument = {
            state: "pending",
            relativePath: path,
            idempotencyKey: crypto.randomUUID(),
            originalCreationPath: path
        };

        this.pathIndex.set(path, doc);
        this.idempotencyKeyIndex.set(doc.idempotencyKey, doc);

        // Awaited so the idempotency key is persisted before any HTTP
        // request is sent — a crash before save would lose the key.
        await this.save();

        return doc;
    }

    /**
     * Confirm a pending create: transition from pending to tracked.
     * Removes the pending doc and inserts a tracked doc with full metadata.
     */
    public confirmCreate(
        idempotencyKey: string,
        documentId: DocumentId,
        serverVersion: VaultUpdateId,
        localHash: string,
        remoteRelativePath: RelativePath
    ): TrackedDocument {
        const pending = this.idempotencyKeyIndex.get(idempotencyKey);
        if (pending === undefined) {
            // The pending doc was already promoted to tracked by
            // assignDocumentId (resolveIdempotencyKeys) or a previous
            // confirmCreate call. Find the tracked doc and update it.
            // Try by documentId first, then by scanning for the key.
            let existing = this.documentIdIndex.get(documentId);
            if (existing?.state !== "tracked") {
                // The server may have assigned a different documentId
                // (e.g., merge). Scan all tracked docs for the key.
                for (const doc of this.documentIdIndex.values()) {
                    if (doc.state === "tracked" && doc.idempotencyKey === idempotencyKey) {
                        existing = doc;
                        break;
                    }
                }
            }
            if (existing?.state === "tracked") {
                // If the server assigned a different documentId than what
                // assignDocumentId set, update the index.
                if (existing.documentId !== documentId) {
                    this.documentIdIndex.delete(existing.documentId);
                    existing.documentId = documentId;
                    this.documentIdIndex.set(documentId, existing);
                }
                existing.serverVersion = serverVersion;
                existing.localHash = localHash;
                existing.remoteRelativePath = remoteRelativePath;
                existing.idempotencyKey = undefined;
                this.lastSeenUpdateIds.add(serverVersion);
                this.saveInTheBackground();
                return existing;
            }
            // Truly not found — nothing to update
            throw new Error(
                `No pending document with idempotency key ${idempotencyKey}`
            );
        }

        const tracked: TrackedDocument = {
            state: "tracked",
            relativePath: pending.relativePath,
            documentId,
            serverVersion,
            localHash,
            remoteRelativePath
        };

        // Remove pending from indexes
        this.idempotencyKeyIndex.delete(idempotencyKey);

        // Update pathIndex (pending -> tracked at same path)
        this.pathIndex.set(tracked.relativePath, tracked);

        // Add to documentIdIndex
        this.documentIdIndex.set(tracked.documentId, tracked);

        this.lastSeenUpdateIds.add(serverVersion);

        this.saveInTheBackground();
        return tracked;
    }

    /**
     * Assign a documentId to a pending document (used by resolveIdempotencyKeys).
     * Sets serverVersion = 0 as a placeholder — the sync path must treat
     * serverVersion === 0 as needing a create retry.
     *
     * Returns the new TrackedDocument, or undefined if the key is not found.
     */
    public assignDocumentId(
        idempotencyKey: string,
        documentId: DocumentId
    ): TrackedDocument | undefined {
        const pending = this.idempotencyKeyIndex.get(idempotencyKey);
        if (pending === undefined) {
            return undefined;
        }

        const tracked: TrackedDocument = {
            state: "tracked",
            relativePath: pending.relativePath,
            documentId,
            serverVersion: 0,
            localHash: "",
            remoteRelativePath: pending.relativePath,
            idempotencyKey: pending.idempotencyKey
        };

        // Remove pending from indexes
        this.idempotencyKeyIndex.delete(idempotencyKey);

        // Update pathIndex
        this.pathIndex.set(tracked.relativePath, tracked);

        // Add to documentIdIndex
        this.documentIdIndex.set(tracked.documentId, tracked);

        this.saveInTheBackground();
        return tracked;
    }

    /**
     * Update an existing tracked document's metadata.
     */
    public updateTracked(
        documentId: DocumentId,
        serverVersion: VaultUpdateId,
        localHash: string,
        remoteRelativePath: RelativePath
    ): void {
        const doc = this.documentIdIndex.get(documentId);
        if (doc?.state !== "tracked") {
            throw new Error(
                `Tracked document with id ${documentId} not found`
            );
        }

        doc.serverVersion = serverVersion;
        doc.localHash = localHash;
        doc.remoteRelativePath = remoteRelativePath;

        this.lastSeenUpdateIds.add(serverVersion);

        this.saveInTheBackground();
    }

    /**
     * Move a document from one path to another. Throws if the target path
     * is occupied by a live document.
     */
    public move(oldPath: string, newPath: string): void {
        const doc = this.pathIndex.get(oldPath);
        if (doc === undefined) {
            return;
        }

        // If another document occupies the target path, it was likely
        // orphaned by an earlier displacement that wasn't reconciled.
        // Remove it from the path index — reconcileWithDisk will
        // re-discover the file if it still exists on disk.
        const existingAtNew = this.pathIndex.get(newPath);
        if (existingAtNew !== undefined && existingAtNew !== doc) {
            this.pathIndex.delete(newPath);
        }

        // Remove from old path
        this.pathIndex.delete(oldPath);

        // Update the document's relativePath
        doc.relativePath = newPath;

        // Insert at new path
        this.pathIndex.set(newPath, doc);

        this.saveInTheBackground();
    }

    /**
     * Mark a document as deleted locally.
     * - Pending: remove entirely (no server-side state to track).
     * - Tracked: transition to deleted-locally (keep in documentIdIndex).
     */
    public deleteLocally(path: string): void {
        const doc = this.pathIndex.get(path);
        if (doc === undefined) {
            return;
        }

        // Remove from pathIndex in all cases
        this.pathIndex.delete(path);

        if (doc.state === "pending") {
            // Remove from idempotencyKeyIndex too
            this.idempotencyKeyIndex.delete(doc.idempotencyKey);
        } else if (doc.state === "tracked") {
            // Transition to deleted-locally
            const deleted: DeletedLocallyDocument = {
                state: "deleted-locally",
                relativePath: doc.relativePath,
                documentId: doc.documentId,
                serverVersion: doc.serverVersion,
                remoteRelativePath: doc.remoteRelativePath
            };
            // Replace in documentIdIndex
            this.documentIdIndex.set(deleted.documentId, deleted);
        }

        this.saveInTheBackground();
    }

    /**
     * Confirm a server-side delete: remove the document entirely.
     */
    public confirmDelete(documentId: DocumentId): void {
        const doc = this.documentIdIndex.get(documentId);
        if (doc === undefined) {
            return;
        }

        this.documentIdIndex.delete(documentId);

        // Also remove from pathIndex if present (tracked docs are in both)
        if (doc.state === "tracked") {
            const atPath = this.pathIndex.get(doc.relativePath);
            if (atPath === doc) {
                this.pathIndex.delete(doc.relativePath);
            }
        }

        this.saveInTheBackground();
    }

    /**
     * Remove a document from all indexes entirely.
     */
    public remove(doc: VirtualDocument): void {
        switch (doc.state) {
            case "pending": {
                this.idempotencyKeyIndex.delete(doc.idempotencyKey);
                const atPath = this.pathIndex.get(doc.relativePath);
                if (atPath === doc) {
                    this.pathIndex.delete(doc.relativePath);
                }
                break;
            }
            case "tracked": {
                this.documentIdIndex.delete(doc.documentId);
                const atPath = this.pathIndex.get(doc.relativePath);
                if (atPath === doc) {
                    this.pathIndex.delete(doc.relativePath);
                }
                break;
            }
            case "deleted-locally": {
                this.documentIdIndex.delete(doc.documentId);
                break;
            }
        }

        this.saveInTheBackground();
    }

    /**
     * Ensure no other document has the given documentId. If a different
     * document already holds it, remove that document and return it (so
     * the caller can do optional file-level cleanup). Returns undefined
     * if no conflict exists.
     */
    public ensureUniqueDocumentId(
        documentId: DocumentId,
        keeper: VirtualDocument
    ): VirtualDocument | undefined {
        const existing = this.documentIdIndex.get(documentId);
        if (existing !== undefined && existing !== keeper) {
            this.remove(existing);
            return existing;
        }
        return undefined;
    }

    // -----------------------------------------------------------------------
    // Persistence
    // -----------------------------------------------------------------------

    public async save(): Promise<void> {
        const data = this.snapshotForSave();
        const previousSave = this.pendingSave;
        const thisSave = (async () => {
            await previousSave.catch(() => {});
            await this.saveData(data);
        })();
        this.pendingSave = thisSave.catch(() => {});
        return thisSave;
    }

    public saveInTheBackground(): void {
        this.ensureConsistency();
        void this.save().catch((error: unknown) => {
            this.logger.error(`Error saving data: ${error}`);
        });
    }

    public reset(): void {
        this.pathIndex.clear();
        this.documentIdIndex.clear();
        this.idempotencyKeyIndex.clear();
        this.lastSeenUpdateIds = new CoveredValues(0);
        this.saveInTheBackground();
    }

    /**
     * Serialize to StoredDatabase format for backward compatibility.
     */
    private snapshotForSave(): StoredDatabase {
        const documents: StoredDocumentMetadata[] = [];

        // Tracked documents
        for (const doc of this.pathIndex.values()) {
            if (doc.state === "tracked") {
                documents.push({
                    relativePath: doc.relativePath,
                    documentId: doc.documentId,
                    parentVersionId: doc.serverVersion,
                    hash: doc.localHash,
                    remoteRelativePath: doc.remoteRelativePath
                });
            }
        }

        // Deleted-locally documents (with isDeleted flag)
        for (const doc of this.documentIdIndex.values()) {
            if (doc.state === "deleted-locally") {
                documents.push({
                    relativePath: doc.relativePath,
                    documentId: doc.documentId,
                    parentVersionId: doc.serverVersion,
                    hash: "",
                    isDeleted: true,
                    remoteRelativePath: doc.remoteRelativePath
                });
            }
        }

        // Pending documents
        const pendingDocuments: StoredPendingDocument[] = [];
        for (const doc of this.idempotencyKeyIndex.values()) {
            pendingDocuments.push({
                relativePath: doc.relativePath,
                idempotencyKey: doc.idempotencyKey,
                originalCreationPath: doc.originalCreationPath
            });
        }

        return {
            documents,
            pendingDocuments,
            lastSeenUpdateId: this.lastSeenUpdateIds.min
        };
    }

    // -----------------------------------------------------------------------
    // Consistency check
    // -----------------------------------------------------------------------

    private ensureConsistency(): void {
        // Check that documentIdIndex has no duplicates (by construction it
        // shouldn't, since it's a Map keyed by documentId). But verify that
        // pathIndex entries with documentIds are consistent.
        const seenDocIds = new Set<string>();
        for (const doc of this.pathIndex.values()) {
            if (doc.state === "tracked") {
                if (seenDocIds.has(doc.documentId)) {
                    throw new Error(
                        `Duplicate documentId ${doc.documentId} found in VFS pathIndex`
                    );
                }
                seenDocIds.add(doc.documentId);
            }
        }
        for (const doc of this.documentIdIndex.values()) {
            if (doc.state === "deleted-locally") {
                if (seenDocIds.has(doc.documentId)) {
                    throw new Error(
                        `Duplicate documentId ${doc.documentId} found across live and deleted documents`
                    );
                }
                seenDocIds.add(doc.documentId);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Disk reconciliation
    // -----------------------------------------------------------------------

    /**
     * Compare VFS entries against files on disk and produce a pure result
     * describing what changed. Does NOT mutate the VFS.
     *
     * @param diskFiles - List of relative paths that currently exist on disk.
     * @param readAndHash - Callback to read a file and return its hash, or
     *   undefined if the file cannot be read.
     */
    public async reconcileWithDisk(
        diskFiles: string[],
        readAndHash: (path: string) => Promise<string | undefined>
    ): Promise<ReconciliationResult> {
        const diskSet = new Set(diskFiles);

        const newFiles: string[] = [];
        const modifiedFiles: { path: string; documentId: string }[] = [];
        const missingFiles: VirtualDocument[] = [];
        const movedFiles: { document: TrackedDocument; newPath: string }[] = [];

        // Collect missing tracked/pending docs (file not on disk)
        const missingTracked: TrackedDocument[] = [];
        for (const doc of this.pathIndex.values()) {
            if (!diskSet.has(doc.relativePath)) {
                if (doc.state === "tracked") {
                    missingTracked.push(doc);
                }
                missingFiles.push(doc);
            }
        }

        // For each disk file, classify it
        for (const path of diskFiles) {
            const doc = this.pathIndex.get(path);

            if (doc === undefined) {
                // File on disk, not in VFS — could be new or a move
                newFiles.push(path);
            } else if (doc.state === "tracked") {
                // Check if content changed
                const fileHash = await readAndHash(path);
                if (
                    fileHash !== undefined &&
                    fileHash !== doc.localHash
                ) {
                    modifiedFiles.push({
                        path,
                        documentId: doc.documentId
                    });
                }
            }
            // If pending, nothing to reconcile — it's already pending
        }

        // Attempt move detection: for each new file, try to match against
        // a missing tracked doc by content hash
        if (missingTracked.length > 0 && newFiles.length > 0) {
            const remainingNew: string[] = [];

            for (const path of newFiles) {
                const fileHash = await readAndHash(path);
                if (fileHash === undefined || fileHash === EMPTY_HASH) {
                    remainingNew.push(path);
                    continue;
                }

                // Find a single unique match among missing tracked docs
                const matches = missingTracked.filter(
                    (doc) => doc.localHash === fileHash
                );

                if (matches.length === 1) {
                    const match = matches[0];
                    movedFiles.push({ document: match, newPath: path });

                    // Remove from missingTracked so it can't match again
                    const idx = missingTracked.indexOf(match);
                    if (idx !== -1) {
                        missingTracked.splice(idx, 1);
                    }

                    // Remove from missingFiles too
                    const missingIdx = missingFiles.indexOf(match);
                    if (missingIdx !== -1) {
                        missingFiles.splice(missingIdx, 1);
                    }
                } else {
                    remainingNew.push(path);
                }
            }

            // Replace newFiles with the remaining unmatched ones
            newFiles.length = 0;
            newFiles.push(...remainingNew);
        }

        return { newFiles, modifiedFiles, missingFiles, movedFiles };
    }
}
