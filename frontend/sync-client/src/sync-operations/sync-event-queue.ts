import type { Settings } from "../persistence/settings";
import type { Logger } from "../tracing/logger";
import { globsToRegexes } from "../utils/globs-to-regexes";
import { removeFromArray } from "../utils/remove-from-array";
import { EventListeners } from "../utils/data-structures/event-listeners";
import {
    SyncEventType,
    type DocumentId,
    type DocumentRecord,
    type FileSyncEvent,
    type RelativePath,
    type StoredSyncState,
    type SyncEvent,
    type VaultUpdateId
} from "./types";
import { MinCovered } from "../utils/data-structures/min-covered";

export const STORED_STATE_SCHEMA_VERSION = 2;

export class SyncEventQueue {
    // Fires synchronously whenever the events array length changes (push, pop,
    // remove, bulk-clear). The Syncer mirrors this into its public count
    // listener; without this hook, listeners only saw deltas at consume time
    // and missed the "queue grew" / "queue cleared on reset" transitions.
    public readonly onPendingUpdateCountChanged = new EventListeners<
        (count: number) => unknown
    >();

    private readonly _lastSeenUpdateId: MinCovered;

    // Primary index of every settled document, keyed by docId. The wire loop
    // (records ↔ server) updates `remoteRelativePath` here as the server
    // assigns/relocates a doc; the Reconciler (records ↔ disk) updates
    // `localPath` here as it places files on disk.
    private readonly byDocId = new Map<DocumentId, DocumentRecord>();

    // Derived index from `localPath -> record`. Maintained alongside every
    // mutation that touches `localPath` so callers (the watcher path through
    // `enqueue`, the Reconciler) get O(1) lookups by disk location. Only
    // contains records whose `localPath !== undefined`.
    private readonly _byLocalPath = new Map<RelativePath, DocumentRecord>();

    // All outstanding operations in order of occurrence,
    // can include multiple generations of the same document,
    // e.g.: a create, delete, create sequence for the same path.
    //
    // The paths within the events must always correspond to the latest
    // path on disk, so the path of each event may be updated multiple
    // times.
    //
    // It maps pending changes onto the local filesystem.
    private readonly events: SyncEvent[] = [];

    // file creations for paths matching any of these patterns are ignored
    // because the user explicitly told us to ignore them.
    private userIgnorePatterns: RegExp[];

    // Hard-coded ignores that callers (e.g. the Syncer for `.vaultlink/**`
    // swap-marker files) pin via `addInternalIgnorePattern`. Folded into
    // `userIgnorePatterns` so the existing match path doesn't need to know
    // about two arrays. Stored separately so a later `onSettingsChanged`
    // event that re-derives `userIgnorePatterns` from settings doesn't
    // forget the internal patterns.
    private readonly internalIgnorePatterns: RegExp[] = [];

    // DocIds whose HTTP DELETE has been acked by the server but whose
    // WebSocket-receipt-driven `removeDocumentById` hasn't run yet (the
    // record is still in `byDocId` because the wire loop keeps it around to
    // recognise late remote updates as "file is missing"). The Reconciler
    // and the remote-update wire-loop handlers consult this set to skip any
    // work that would resurrect the doc — without it, a placement-pending
    // record (`localPath === undefined` after the LocalDelete enqueue) would
    // be re-fetched from the server and written back to disk, or a late
    // RemoteChange for the same doc would stash the pre-delete bytes into
    // `pendingPlacementContent` for the Reconciler to "place".
    //
    // Cleared as a side effect of `removeDocumentById`. Also cleared on
    // `clearAllState` / schema-version-mismatch reset.
    private readonly _pendingServerDeletes = new Set<DocumentId>();

    public constructor(
        private readonly settings: Settings,
        private readonly logger: Logger,
        initialState: Partial<StoredSyncState> | undefined,
        private readonly saveData: (data: StoredSyncState) => Promise<void>
    ) {
        this.userIgnorePatterns = globsToRegexes(
            this.settings.getSettings().ignorePatterns,
            this.logger
        );

        this.settings.onSettingsChanged.add((newSettings) => {
            this.userIgnorePatterns = [
                ...globsToRegexes(newSettings.ignorePatterns, this.logger),
                ...this.internalIgnorePatterns
            ];
        });

        initialState ??= {};

        const persistedSchemaVersion = initialState.schemaVersion;
        if (persistedSchemaVersion !== STORED_STATE_SCHEMA_VERSION) {
            this.logger.info(
                `Persisted state schema version is ${persistedSchemaVersion ?? "unset"}, expected ${STORED_STATE_SCHEMA_VERSION}; discarding persisted documents and watermark so the offline scan re-derives state from disk`
            );
            initialState = {};
            // Schedule a save so the new schema version sticks even if the user
            // never makes a change. Don't await here (constructor is sync); the
            // first real save in `save()` will pin it down anyway.
            void this.saveData({
                schemaVersion: STORED_STATE_SCHEMA_VERSION,
                documents: [],
                lastSeenUpdateId: 0
            });
        }

        if (initialState.documents !== undefined) {
            for (const record of initialState.documents) {
                this.byDocId.set(record.documentId, record);
                if (record.localPath !== undefined) {
                    // Defensive: if two persisted records share the same
                    // localPath (shouldn't happen given the invariant
                    // enforced at every mutation point, but persisted
                    // state from older buggy versions could violate it),
                    // displace the prior holder so we don't end up with
                    // a shadowed record on load.
                    const displaced = this._byLocalPath.get(record.localPath);
                    if (displaced !== undefined && displaced !== record) {
                        displaced.localPath = undefined;
                        this.logger.warn(
                            `Persisted state had two records sharing localPath ` +
                                `${record.localPath} (${displaced.documentId} and ` +
                                `${record.documentId}); clearing the prior holder's ` +
                                `localPath so the reconciler re-places it`
                        );
                    }
                    this._byLocalPath.set(record.localPath, record);
                }
            }
        }
        this._lastSeenUpdateId = new MinCovered(
            initialState.lastSeenUpdateId ?? 0
        );

        this.logger.debug(
            `Loaded ${this.byDocId.size} documents and lastSeenUpdateId=${this._lastSeenUpdateId.min} from storage`
        );
    }

    public get pendingUpdateCount(): number {
        return this.events.length;
    }

    public get syncedDocumentCount(): number {
        return this.byDocId.size;
    }

    /**
     * Read-only view of the `localPath -> record` index. Use for O(1) lookups
     * by disk location; the index is maintained by every mutation that
     * touches `localPath` (`upsertRecord`, `setLocalPath`, the rename branch
     * of `enqueue`, `removeDocumentById`).
     */
    public get byLocalPath(): ReadonlyMap<RelativePath, DocumentRecord> {
        return this._byLocalPath;
    }

    public get lastSeenUpdateId(): VaultUpdateId {
        return this._lastSeenUpdateId.min;
    }

    public set lastSeenUpdateId(id: VaultUpdateId) {
        this._lastSeenUpdateId.add(id);
    }

    /**
     * Pin an additional ignore pattern that survives setting reloads. Used
     * by the Syncer to hide internal scratch paths (e.g. `.vaultlink/**`
     * swap markers written by the Reconciler) from the watcher-driven
     * enqueue path. The pattern is compiled with the same `globsToRegexes`
     * used for user-configurable ignores; matching uses the existing
     * userIgnorePatterns array so there's only one match path.
     */
    public addInternalIgnorePattern(pattern: string): void {
        const compiled = globsToRegexes([pattern], this.logger);
        this.internalIgnorePatterns.push(...compiled);
        this.userIgnorePatterns.push(...compiled);
    }

    public async enqueue(input: FileSyncEvent): Promise<void> {
        const path =
            input.type === SyncEventType.RemoteChange
                ? input.remoteVersion.relativePath
                : input.path;

        if (this.userIgnorePatterns.some((pattern) => pattern.test(path))) {
            this.logger.info(
                `Ignoring ${input.type} for ${path} as it matches ignore patterns`
            );
            return;
        }

        if (input.type === SyncEventType.RemoteChange) {
            this.events.push(input);
            this.notifyPendingUpdateCountChanged();
            return;
        }

        if (input.type === SyncEventType.LocalCreate) {
            this.events.push({
                type: SyncEventType.LocalCreate,
                path,
                resolvers: Promise.withResolvers()
            });
            this.notifyPendingUpdateCountChanged();
            return;
        }

        const lookupPath =
            input.type === SyncEventType.LocalUpdate &&
            input.oldPath !== undefined
                ? input.oldPath
                : path;
        const record = this._byLocalPath.get(lookupPath);

        // latest creation must take precedence as it's from the doc's latest generation
        const pendingDocumentId: Promise<DocumentId> | undefined =
            this.findLatestCreateForPath(lookupPath)?.resolvers.promise;

        const documentId: DocumentId | undefined = record?.documentId;

        const effectiveDocumentId:
            | Promise<DocumentId>
            | DocumentId
            | undefined = pendingDocumentId ?? documentId;
        if (effectiveDocumentId === undefined) {
            // we can get here when deleting a local document after a remote update
            return;
        }

        if (input.type === SyncEventType.LocalDelete) {
            // Push BEFORE awaiting `setLocalPath` (and its inner `save()`).
            // See the comment below on the synchronicity contract with
            // `ensureDraining()`.
            this.events.push({
                type: SyncEventType.LocalDelete,
                documentId: effectiveDocumentId,
                path: lookupPath
            });
            this.notifyPendingUpdateCountChanged();
            if (record !== undefined) {
                // The file is gone from disk; clear the doc's localPath so the
                // Reconciler doesn't try to operate on a vacated slot.
                await this.setLocalPath(record.documentId, undefined);
            }
            return;
        }

        const isUserRename = input.oldPath !== undefined;
        let needsSave = false;
        if (input.oldPath !== undefined) {
            if (pendingDocumentId !== undefined) {
                this.updatePendingCreatePath(input.oldPath, path);
            } else {
                if (record === undefined) {
                    throw new Error(
                        "Unreachable: record must be defined for non-pending update"
                    );
                }
                // The user renamed `oldPath` onto `path`. If `path` was
                // already tracked by a *different* doc (the OS rename
                // overwrote that file), that doc effectively no longer
                // exists locally — its content was clobbered. Without
                // explicitly recording the loss the doc would silently
                // drop out of the byLocalPath index below and we'd skip
                // notifying the server, leaving a phantom on the remote
                // that other agents still see. Enqueue a LocalDelete for
                // it so the server learns about the deletion.
                const displacedRecord = this._byLocalPath.get(path);
                if (
                    displacedRecord !== undefined &&
                    displacedRecord.documentId !== record.documentId
                ) {
                    this.events.push({
                        type: SyncEventType.LocalDelete,
                        documentId: displacedRecord.documentId,
                        // Snapshot the path; once we move `record` onto
                        // `path` below the displaced doc will no longer
                        // resolve via `byLocalPath`.
                        path
                    });
                    // Drop the displaced doc's localPath: its file on
                    // disk is gone (overwritten by the rename).
                    // Mutate synchronously so the byLocalPath index is
                    // correct before we move `record` onto the same
                    // slot below; the persist runs in the trailing
                    // `save()` so we don't await before pushing the
                    // LocalUpdate (synchronicity contract).
                    this.mutateLocalPathInPlace(displacedRecord, undefined);
                    needsSave = true;
                }
                // Move record's localPath onto the new slot. We mutate
                // the record in place rather than re-creating it so any
                // held reference (drain handlers, queued events) sees
                // the new path on its next read.
                this.mutateLocalPathInPlace(record, path);
                // Retarget any queued LocalUpdates for this doc onto
                // the new path. The queue's invariant — and what
                // `skipIfOversized` and the watcher dedup checks bake
                // in — is that `event.path` always points at the doc's
                // current disk location.
                for (const e of this.events) {
                    if (
                        e.type === SyncEventType.LocalUpdate &&
                        e.documentId === record.documentId
                    ) {
                        e.path = path;
                    }
                }
                needsSave = true;
            }
        }

        // Push BEFORE awaiting `save()`. The synchronicity contract is:
        // `Syncer.ensureDraining()` runs immediately after each `enqueue`,
        // and the drain only sees what's in `events[]`. Pushing after an
        // await would let the drain start, see an empty queue, exit, and
        // leave the event stranded.
        this.events.push({
            type: SyncEventType.LocalUpdate,
            documentId: effectiveDocumentId,
            path,
            originalPath: path,
            isUserRename
        });
        this.notifyPendingUpdateCountChanged();

        if (needsSave) {
            await this.save();
        }
    }

    public async next(): Promise<SyncEvent | undefined> {
        const event = this.events.shift();
        if (event !== undefined) {
            this.notifyPendingUpdateCountChanged();
        }
        return event;
    }

    /**
     * Return the next event without removing it. Drain uses this so the
     * event stays visible in the queue while it is being processed —
     * critical for `findLatestCreateForPath` to update an in-flight
     * `LocalCreate`'s path when a rename arrives mid-process. Also marks
     * the event as in-flight so dedup checks in `enqueue` know not to
     * fold a fresh content change into an event whose disk read already
     * happened.
     */
    public peekFront(): SyncEvent | undefined {
        return this.events[0];
    }

    /**
     * Remove a specific event after `peekFront`-based processing is done.
     * Idempotent — safe to call when the event was already taken out by
     * `resolveCreate` (which clears a same-path pending create that a
     * remote-create handler just absorbed).
     */
    public consumeEvent(event: SyncEvent): void {
        if (removeFromArray(this.events, event)) {
            this.notifyPendingUpdateCountChanged();
        }
    }

    /**
     * Call once a create has been acknowledged by the server.
     *
     * Queued `LocalUpdate` / `LocalDelete` events that were pushed while
     * this create was still in-flight carry the create's `resolvers.promise`
     * as their `documentId` (see the `pendingDocumentId` branch of
     * `enqueue`). We must rewrite those references to the resolved string
     * id *before* calling `upsertRecord`, otherwise its event-rewrite loop
     * (which compares `e.documentId === record.documentId`) would silently
     * skip them — leaving their `event.path` pointing at the pre-rename
     * slot and causing the next drain step's `getFileSize(event.path)` to
     * throw `FileNotFoundError`, dropping the user's intent.
     */
    public async resolveCreate(
        event: Extract<SyncEvent, { type: SyncEventType.LocalCreate }>,
        record: DocumentRecord
    ): Promise<void> {
        if (removeFromArray(this.events, event)) {
            this.notifyPendingUpdateCountChanged();
        }
        this.replacePendingDocumentId(
            event.resolvers.promise,
            record.documentId
        );
        await this.upsertRecord(record);
        event.resolvers.resolve(record.documentId);
    }

    /**
     * Swap a pending create's `Promise<DocumentId>` reference for the
     * resolved string id across every queued `LocalUpdate` / `LocalDelete`.
     * Call this whenever a create resolves (regular ack OR
     * displacement-merge into an existing doc) — see `resolveCreate` for
     * the failure mode if it's skipped.
     */
    public replacePendingDocumentId(
        promise: Promise<DocumentId>,
        documentId: DocumentId
    ): void {
        for (const e of this.events) {
            if (
                (e.type === SyncEventType.LocalUpdate ||
                    e.type === SyncEventType.LocalDelete) &&
                e.documentId === promise
            ) {
                e.documentId = documentId;
            }
        }
    }

    /**
     * Insert or merge a document record by `documentId`. When a record with
     * the same docId already exists it is mutated in place so any held
     * references (drain handlers, queued events) keep seeing the up-to-date
     * fields on their next read — this stays load-bearing for the Syncer's
     * drain handlers, which await across HTTP roundtrips.
     *
     * Maintains the `byLocalPath` index. If the `localPath` changes the
     * relocation goes through `setLocalPath` (which also persists), so the
     * caller doesn't need to call `save()` separately.
     */
    public async upsertRecord(record: DocumentRecord): Promise<void> {
        const existing = this.byDocId.get(record.documentId);
        if (existing === undefined) {
            const target: DocumentRecord = { ...record };
            this.byDocId.set(record.documentId, target);
            if (target.localPath !== undefined) {
                // Route through `mutateLocalPathInPlace` so the
                // localPath/byLocalPath invariant is upheld: if another
                // record already holds this slot, displace it (clear
                // its localPath) before installing `target`. Otherwise
                // we'd leave the displaced record shadowed (its
                // `localPath` still points at a slot that no longer
                // belongs to it), which the Reconciler would then
                // "rescue" by reading/renaming the file at that path
                // — but that file belongs to `target` now, causing
                // data loss.
                target.localPath = undefined;
                this.mutateLocalPathInPlace(target, record.localPath);
            }
        } else {
            existing.parentVersionId = record.parentVersionId;
            existing.remoteHash = record.remoteHash;
            existing.remoteRelativePath = record.remoteRelativePath;
            if (existing.localPath !== record.localPath) {
                // setLocalPath re-keys `byLocalPath` and persists.
                return this.setLocalPath(record.documentId, record.localPath);
            }
        }
        return this.save();
    }

    /**
     * Update the `localPath` of an already-tracked record (by docId) and
     * re-key the `byLocalPath` index. Called by both the watcher path
     * (through `enqueue`) and the Reconciler.
     *
     * Pass `undefined` to mark the doc as "no local file" — the Reconciler
     * will place a file later (e.g. a remote create whose
     * `remoteRelativePath` slot is occupied at receive time).
     */
    public async setLocalPath(
        documentId: DocumentId,
        newLocalPath: RelativePath | undefined
    ): Promise<void> {
        const record = this.byDocId.get(documentId);
        if (record === undefined) {
            return;
        }
        this.mutateLocalPathInPlace(record, newLocalPath);
        return this.save();
    }

    public async removeDocumentById(documentId: DocumentId): Promise<void> {
        const record = this.byDocId.get(documentId);
        if (record === undefined) {
            // Still clear any deletion-pending mark and purge stale
            // RemoteChange events so a never-tracked doc doesn't accumulate
            // entries.
            this._pendingServerDeletes.delete(documentId);
            this.purgeRemoteChangesForDocumentId(documentId);
            return;
        }
        if (
            record.localPath !== undefined &&
            this._byLocalPath.get(record.localPath) === record
        ) {
            this._byLocalPath.delete(record.localPath);
        }
        this.byDocId.delete(documentId);
        this._pendingServerDeletes.delete(documentId);
        // Drop any pending RemoteChange events for this doc. A common case:
        // a catch-up RemoteChange for the doc was deferred indefinitely
        // while the user's LocalDelete (and any LocalUpdate behind it) sat
        // in the queue ahead of it. Once those drain and the doc is
        // removed, a still-pending RemoteChange for an earlier version
        // would be processed by `processRemoteCreateForNewDocument` (the
        // doc is now untracked, and catch-up's `isNewFile=true` semantics
        // qualify it as a fresh create), resurrecting the doc on disk
        // with stale bytes that disagree with every other agent.
        this.purgeRemoteChangesForDocumentId(documentId);
        return this.save();
    }

    /**
     * Mark a doc as "HTTP DELETE has been acked by the server but the
     * WebSocket receipt that would call `removeDocumentById` hasn't arrived
     * yet". The Reconciler and remote-update wire-loop handlers consult
     * `hasPendingServerDelete` to skip any work that would resurrect the
     * doc. Cleared automatically by `removeDocumentById`.
     */
    public markServerDeletePending(documentId: DocumentId): void {
        this._pendingServerDeletes.add(documentId);
    }

    public hasPendingServerDelete(documentId: DocumentId): boolean {
        return this._pendingServerDeletes.has(documentId);
    }

    public getDocumentByDocumentId(
        target: DocumentId
    ): DocumentRecord | undefined {
        return this.byDocId.get(target);
    }

    public getDocumentByDocumentIdOrFail(target: DocumentId): DocumentRecord {
        const result = this.getDocumentByDocumentId(target);
        if (!result) {
            throw new Error(`No document found with id ${target}`);
        }
        return result;
    }

    public getRecordByLocalPath(
        path: RelativePath
    ): DocumentRecord | undefined {
        return this._byLocalPath.get(path);
    }

    public async save(): Promise<void> {
        return this.saveData({
            schemaVersion: STORED_STATE_SCHEMA_VERSION,
            documents: Array.from(this.byDocId.values()),
            lastSeenUpdateId: this.lastSeenUpdateId
        });
    }

    public allSettledDocuments(): Map<RelativePath, DocumentRecord> {
        const result = new Map<RelativePath, DocumentRecord>();
        for (const record of this.byDocId.values()) {
            if (record.localPath !== undefined) {
                result.set(record.localPath, record);
            }
        }
        return result;
    }

    /**
     * Every tracked record, regardless of whether it has been placed on
     * disk yet. The Reconciler uses this to find records whose
     * `localPath === undefined` (e.g. a remote create that landed when
     * its target slot was occupied) and try to place them once the
     * obstruction clears. `allSettledDocuments` filters those out, so
     * relying on it would render placement-pending records invisible
     * forever.
     */
    public allRecords(): Iterable<DocumentRecord> {
        return this.byDocId.values();
    }

    public hasPendingEventsForPath(path: RelativePath): boolean {
        const record = this._byLocalPath.get(path);
        if (record === undefined) {
            return true; // if we don't know about this path, it must be pending creation
        }
        const docId = record.documentId;
        return this.events.some(
            (e) =>
                (e.type === SyncEventType.LocalCreate && e.path === path) ||
                (e.type === SyncEventType.LocalUpdate &&
                    e.documentId === docId) ||
                (e.type === SyncEventType.LocalDelete &&
                    e.documentId === docId) ||
                (e.type === SyncEventType.RemoteChange &&
                    // we care about the local path not the remote
                    this.getDocumentByDocumentId(e.remoteVersion.documentId)
                        ?.localPath === path)
        );
    }

    public hasPendingLocalEventsForDocumentId(documentId: DocumentId): boolean {
        return this.events.some(
            (e) =>
                (e.type === SyncEventType.LocalUpdate &&
                    e.documentId === documentId) ||
                (e.type === SyncEventType.LocalDelete &&
                    e.documentId === documentId)
        );
    }

    public async clearAllState(): Promise<void> {
        this.clearPending();
        this.byDocId.clear();
        this._byLocalPath.clear();
        this._pendingServerDeletes.clear();
        this._lastSeenUpdateId.reset();
        await this.save();
    }

    public clearPending(): void {
        const hadEvents = this.events.length > 0;
        this.rejectAllPendingCreates();
        this.events.length = 0;
        if (hadEvents) {
            this.notifyPendingUpdateCountChanged();
        }
    }

    public findLatestCreateForPath(
        path: RelativePath
    ): Extract<SyncEvent, { type: SyncEventType.LocalCreate }> | undefined {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (e.type === SyncEventType.LocalCreate && e.path === path) {
                return e;
            }
        }
        return undefined;
    }

    public updatePendingCreatePath(
        oldPath: RelativePath,
        newPath: RelativePath
    ): void {
        const createEvent = this.findLatestCreateForPath(oldPath);
        if (createEvent === undefined) {
            return;
        }

        const { promise } = createEvent.resolvers;
        createEvent.path = newPath;

        for (const e of this.events) {
            if (
                e.type === SyncEventType.LocalUpdate &&
                e.documentId === promise
            ) {
                e.path = newPath;
            }
        }
    }

    /**
     * Synchronous half of `setLocalPath`: mutate `record.localPath` and
     * re-key `_byLocalPath` without persisting. Used by `enqueue`'s
     * rename branch where the synchronicity contract requires we push
     * the LocalUpdate event before awaiting the save.
     *
     * Enforces the invariant
     * `record.localPath !== undefined ⇒ byLocalPath.get(record.localPath) === record`.
     * If `newLocalPath` is currently held by a different record, that
     * record is *displaced*: its `localPath` is cleared so it enters
     * placement-pending state, and the Reconciler's next pass will
     * re-place it via `tryInitialPlacement`. Without this displacement
     * the prior holder would remain shadowed (its `localPath === P`
     * but `byLocalPath[P]` points elsewhere) and the Reconciler could
     * later try to "rescue" the shadowed record by reading/renaming
     * the file at `P` — which belongs to the new owner now — causing
     * data loss. This is the architectural fix for bug D
     * (`Files from agent-1 missing in agent-0` after a same-path
     * create cycle).
     */
    private mutateLocalPathInPlace(
        record: DocumentRecord,
        newLocalPath: RelativePath | undefined
    ): void {
        if (
            record.localPath !== undefined &&
            this._byLocalPath.get(record.localPath) === record
        ) {
            this._byLocalPath.delete(record.localPath);
        }
        record.localPath = newLocalPath;
        if (newLocalPath !== undefined) {
            const displaced = this._byLocalPath.get(newLocalPath);
            if (displaced !== undefined && displaced !== record) {
                // Invariant: `byLocalPath[displaced.localPath] === displaced`.
                // We're about to overwrite that slot, so clear the
                // displaced record's localPath; the reconciler will
                // re-place it via tryInitialPlacement on the next pass.
                displaced.localPath = undefined;
            }
            this._byLocalPath.set(newLocalPath, record);
        }
    }

    private notifyPendingUpdateCountChanged(): void {
        this.onPendingUpdateCountChanged.trigger(this.events.length);
    }

    private rejectAllPendingCreates(): void {
        for (const event of this.events) {
            if (event.type === SyncEventType.LocalCreate) {
                event.resolvers.promise.catch(() => {
                    /* suppressed — consumer may not be listening */
                });
                event.resolvers.reject(new Error("Create was cancelled"));
            }
        }
    }

    private purgeRemoteChangesForDocumentId(documentId: DocumentId): void {
        const toRemove = this.events.filter(
            (e) =>
                e.type === SyncEventType.RemoteChange &&
                e.remoteVersion.documentId === documentId
        );
        for (const event of toRemove) {
            if (event.type === SyncEventType.RemoteChange) {
                // Advance the watermark for the dropped event so the gap
                // doesn't leave the catch-up replay this id forever.
                this._lastSeenUpdateId.add(event.remoteVersion.vaultUpdateId);
            }
            removeFromArray(this.events, event);
        }
        if (toRemove.length > 0) {
            this.notifyPendingUpdateCountChanged();
        }
    }
}
