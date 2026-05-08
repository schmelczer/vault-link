import type { FileOperations } from "../file-operations/file-operations";
import { FileNotFoundError } from "../errors/file-not-found-error";
import { FileAlreadyExistsError } from "../errors/file-already-exists-error";
import type { Logger } from "../tracing/logger";
import type { SyncService } from "../services/sync-service";
import type { SyncEventQueue } from "./sync-event-queue";
import type { DocumentId, DocumentRecord, RelativePath } from "./types";
import { hash } from "../utils/hash";
import { SyncResetError } from "../errors/sync-reset-error";

const SWAP_MARKER_DIR = ".vaultlink";
const SWAP_MARKER_PREFIX = "swap-";
const SWAP_MARKER_SUFFIX = ".json";

interface SwapLeg {
    documentId: DocumentId;
    from: RelativePath;
    to: RelativePath;
    expectedHashOnFrom: string;
}

interface SwapMarker {
    uuid: string;
    legs: SwapLeg[];
}

interface PlannedMove {
    record: DocumentRecord;
    from: RelativePath;
    to: RelativePath;
}

function tryParseSwapMarker(bytes: Uint8Array): SwapMarker | undefined {
    try {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        return JSON.parse(new TextDecoder().decode(bytes)) as SwapMarker;
    } catch {
        return undefined;
    }
}

/**
 * The Reconciler is the second of the sync engine's two loops. The wire
 * loop (records ↔ server) updates `record.remoteRelativePath` and writes
 * file content into `record.localPath`; it does not move files for path
 * placement. The Reconciler (records ↔ disk) runs after every wire-loop
 * step and best-effort lines disk up with `remoteRelativePath` for every
 * tracked record.
 *
 * "Best effort" means: any per-record obstacle (slot occupied, file
 * missing, etc.) is silently skipped and retried on the next pass.
 * `run()` never throws — per-record errors are logged and the next
 * record is processed.
 *
 * Three shapes of work exist:
 *   1. Initial placement — `localPath === undefined`. The wire loop
 *      created the record with no on-disk presence (e.g. a remote create
 *      whose target slot was occupied at receive time). If the slot is
 *      free now, fetch content (from `pendingPlacementContent` if a
 *      handler stuffed it for us, otherwise from the server) and write.
 *   2. Simple rename — `localPath !== remoteRelativePath` and no other
 *      tracked record wants our current slot. Plain rename.
 *   3. Cycle — two or more records want each others' current slots
 *      (A → B, B → A; or longer rotations). Resolved by reading every
 *      member's bytes into memory then overwriting each target slot.
 *      A write-ahead marker file lets `recoverFromInterruptedSwap()`
 *      finish a swap that crashed mid-flight on next startup.
 */
export class Reconciler {
    public constructor(
        private readonly logger: Logger,
        private readonly operations: FileOperations,
        private readonly syncService: SyncService,
        private readonly queue: SyncEventQueue,
        // Bytes already in hand from a recent server response, keyed by
        // docId. Wire-loop handlers populate this transiently when they
        // have content for a record they just upserted with `localPath
        // === undefined`; the reconciler uses it on the same pass
        // instead of re-fetching from the server. Keys are deleted when
        // consumed.
        private readonly pendingPlacementContent: Map<DocumentId, Uint8Array>
    ) {}

    /**
     * Single best-effort pass. Walks every tracked record, places
     * unplaced ones, and reorganises any whose `localPath !==
     * remoteRelativePath`. Never throws — per-record failures are
     * logged and the next record is processed. The Syncer is expected
     * to call this after every wire-loop drain step, so any record
     * skipped this pass gets another shot once the obstructing event
     * is processed.
     */
    public async run(): Promise<void> {
        const allRecords = this.collectAllRecords();

        const movesNeeded: PlannedMove[] = [];
        const deferredPlacements: DocumentRecord[] = [];

        for (const record of allRecords) {
            if (record.localPath === record.remoteRelativePath) {
                continue;
            }

            // The reconciler operates on settled records. A record with a
            // pending LocalUpdate or LocalDelete is mid-flight: the wire
            // loop owns the user's intent (rename target, edit content,
            // deletion) and the record's `remoteRelativePath` may still
            // reflect the pre-rename server state. Touching disk now
            // would race the wire loop — e.g. a queued user-rename
            // LocalUpdate would find its source path vacated by the
            // reconciler moving the file back to the stale
            // `remoteRelativePath`. Skip; once the wire loop drains the
            // pending events, a subsequent reconciler pass sees a
            // settled record and converges.
            if (
                this.queue.hasPendingLocalEventsForDocumentId(record.documentId)
            ) {
                continue;
            }

            // The doc has been deleted server-side (HTTP DELETE acked) but
            // the WebSocket receipt that would `removeDocumentById` hasn't
            // arrived yet. The record looks like "needs initial placement"
            // (`localPath === undefined`, since the LocalDelete enqueue
            // cleared it), but placing would resurrect a doc the user
            // explicitly deleted. Skip; `processRemoteDelete` will remove
            // the record entirely once the WS receipt arrives.
            if (this.queue.hasPendingServerDelete(record.documentId)) {
                continue;
            }

            if (record.localPath === undefined) {
                deferredPlacements.push(record);
                continue;
            }

            // localPath !== undefined and !== remoteRelativePath. Plan a
            // move. First defensive existence check: the file may have
            // been deleted between the wire loop touching disk and this
            // reconciler pass — the watcher's LocalDelete will land
            // shortly and fix the record. Skip silently.
            try {
                if (!(await this.operations.exists(record.localPath))) {
                    this.logger.debug(
                        `Reconciler: record ${record.documentId} localPath ${record.localPath} ` +
                            `is missing on disk; skipping (LocalDelete will catch up)`
                    );
                    continue;
                }
            } catch (e) {
                this.logger.error(
                    `Reconciler: existence check failed for ${record.localPath}: ${String(e)}`
                );
                continue;
            }

            movesNeeded.push({
                record,
                from: record.localPath,
                to: record.remoteRelativePath
            });
        }

        if (movesNeeded.length > 0) {
            await this.executeMoves(movesNeeded);
        }

        // Run placements *after* moves so a placement whose target slot
        // was occupied by a tracked record at the start of the pass can
        // still succeed once that record's move frees the slot. Without
        // this ordering, a placement-pending record stalls until the
        // next reconciler tick — which only fires when new events
        // arrive, leaving the doc absent on disk if the queue happens
        // to be quiescent at that moment.
        for (const record of deferredPlacements) {
            // Re-check the gating conditions: a pending event may have
            // been enqueued for this doc while we were processing
            // moves above, and an interleaved placement would race
            // it.
            if (
                this.queue.hasPendingLocalEventsForDocumentId(record.documentId)
            ) {
                continue;
            }
            if (this.queue.hasPendingServerDelete(record.documentId)) {
                continue;
            }
            if (record.localPath !== undefined) {
                continue;
            }
            await this.tryInitialPlacement(record);
        }
    }

    /**
     * Read any swap-marker file left behind by a crash mid-swap and
     * roll forward. Called once on startup before the Reconciler
     * begins normal passes. Idempotent: with no marker, a no-op.
     */
    public async recoverFromInterruptedSwap(): Promise<void> {
        let markerPaths: RelativePath[] = [];
        try {
            markerPaths = await this.findSwapMarkerFiles();
        } catch (e) {
            this.logger.error(
                `Reconciler: failed to scan for swap markers: ${String(e)}`
            );
            return;
        }

        for (const markerPath of markerPaths) {
            try {
                await this.recoverFromOneMarker(markerPath);
            } catch (e) {
                this.logger.error(
                    `Reconciler: recovery from ${markerPath} failed: ${String(e)}`
                );
            }
        }
    }

    private collectAllRecords(): DocumentRecord[] {
        // Iterate every tracked record — placement-pending ones
        // (`localPath === undefined`) included. `allSettledDocuments`
        // filters those out, which would render records born from a
        // remote create that landed on an occupied slot (no on-disk
        // file, no entry in `pendingPlacementContent` either, since the
        // wire loop deliberately doesn't buffer their content) invisible
        // forever. `pendingPlacementContent` is purely a cache for
        // `tryInitialPlacement`'s content fetch — not a record-discovery
        // channel.
        const out: DocumentRecord[] = [];
        for (const record of this.queue.allRecords()) {
            out.push(record);
        }

        // Best-effort cleanup: drop cached content for docs the queue
        // no longer tracks. Previously this happened as a side effect of
        // the placement-pending discovery loop; do it explicitly now.
        if (this.pendingPlacementContent.size > 0) {
            for (const docId of this.pendingPlacementContent.keys()) {
                if (this.queue.getDocumentByDocumentId(docId) === undefined) {
                    this.pendingPlacementContent.delete(docId);
                }
            }
        }

        return out;
    }

    private async tryInitialPlacement(record: DocumentRecord): Promise<void> {
        const target = record.remoteRelativePath;

        if (this.queue.hasPendingCreateForPath(target)) {
            this.logger.debug(
                `Reconciler: cannot place ${record.documentId} at ${target} ` +
                    `— pending local create still claims that path; will retry next pass`
            );
            return;
        }

        // Slot occupancy: pre-check both the disk and our tracked
        // records. Either form of occupancy means we wait — the
        // occupant's own reconciliation pass (after their next wire-loop
        // step) will move them off this slot.
        try {
            if (await this.operations.exists(target)) {
                this.logger.debug(
                    `Reconciler: cannot place ${record.documentId} at ${target} ` +
                        `— slot occupied on disk; will retry next pass`
                );
                return;
            }
        } catch (e) {
            this.logger.error(
                `Reconciler: existence check failed for ${target}: ${String(e)}`
            );
            return;
        }
        if (this.queue.byLocalPath.get(target) !== undefined) {
            this.logger.debug(
                `Reconciler: cannot place ${record.documentId} at ${target} ` +
                    `— slot tracked by another record; will retry next pass`
            );
            return;
        }

        let content = this.pendingPlacementContent.get(record.documentId);
        if (content === undefined) {
            try {
                content = await this.syncService.getDocumentVersionContent({
                    documentId: record.documentId,
                    vaultUpdateId: record.parentVersionId
                });
            } catch (e) {
                if (e instanceof SyncResetError) {
                    this.logger.info(
                        `Reconciler: content fetch for ${record.documentId} interrupted by sync reset`
                    );
                    return;
                }
                this.logger.error(
                    `Reconciler: failed to fetch content for ${record.documentId}: ${String(e)}`
                );
                return;
            }
        }

        try {
            await this.operations.create(target, content);
        } catch (e) {
            if (e instanceof FileNotFoundError) {
                this.logger.debug(
                    `Reconciler: create at ${target} hit FileNotFound (likely parent ` +
                        `directory race); will retry next pass`
                );
                return;
            }
            if (e instanceof FileAlreadyExistsError) {
                this.logger.debug(
                    `Reconciler: create at ${target} lost TOCTOU race ` +
                        `(slot occupied between pre-check and write); will retry next pass`
                );
                return;
            }
            this.logger.error(
                `Reconciler: create at ${target} failed: ${String(e)}`
            );
            return;
        }

        try {
            await this.queue.setLocalPath(record.documentId, target);
        } catch (e) {
            this.logger.error(
                `Reconciler: setLocalPath after create failed for ${record.documentId}: ${String(e)}`
            );
            return;
        }
        this.pendingPlacementContent.delete(record.documentId);
        this.logger.debug(
            `Reconciler: placed ${record.documentId} at ${target}`
        );
    }

    private async executeMoves(moves: PlannedMove[]): Promise<void> {
        // Build a directed graph: each move (record currently at `from`,
        // wants to go to `to`) gets an edge to whatever tracked record
        // currently holds `to`. A node with no outgoing edge is a leaf
        // in the DAG: its target slot is held by no tracked record. If
        // the slot is held by an *untracked* file we can't safely
        // displace it (no record to relocate); skip those moves and
        // let the next pass retry.
        const movesByDocId = new Map<DocumentId, PlannedMove>();
        for (const move of moves) {
            movesByDocId.set(move.record.documentId, move);
        }

        const skipped = new Set<DocumentId>();
        const edges = new Map<DocumentId, DocumentId | null>();

        for (const move of moves) {
            const occupant = this.queue.byLocalPath.get(move.to);
            if (occupant === undefined) {
                let occupied = false;
                try {
                    occupied = await this.operations.exists(move.to);
                } catch (e) {
                    this.logger.error(
                        `Reconciler: existence check failed for ${move.to}: ${String(e)}`
                    );
                    skipped.add(move.record.documentId);
                    continue;
                }
                if (occupied) {
                    this.logger.debug(
                        `Reconciler: move ${move.record.documentId} -> ${move.to} blocked ` +
                            `by untracked file; will retry next pass`
                    );
                    skipped.add(move.record.documentId);
                    continue;
                }
                edges.set(move.record.documentId, null);
            } else if (occupant.documentId === move.record.documentId) {
                // Self-loop on `to` shouldn't normally happen — we
                // skipped records where localPath===remoteRelativePath
                // up front. Defensive: nothing to do.
                continue;
            } else if (movesByDocId.has(occupant.documentId)) {
                edges.set(move.record.documentId, occupant.documentId);
            } else {
                // Occupant is a tracked record that doesn't *want* to
                // move (its localPath === its remoteRelativePath). We
                // can't dislodge it without orphaning its on-disk
                // file; skip and retry.
                this.logger.debug(
                    `Reconciler: move ${move.record.documentId} -> ${move.to} blocked by ` +
                        `tracked record ${occupant.documentId} which is not moving; ` +
                        `will retry next pass`
                );
                skipped.add(move.record.documentId);
            }
        }

        // SCC decomposition (Tarjan's algorithm) over the move graph.
        const sccs = this.tarjanSccs(edges, skipped);

        // Topo-sort the DAG of SCCs (leaves first). Tarjan emits SCCs
        // in reverse topological order — leaves first — which is
        // already what we want.
        for (const scc of sccs) {
            if (scc.length === 1) {
                const [docId] = scc;
                if (skipped.has(docId)) {
                    continue;
                }
                const move = movesByDocId.get(docId);
                if (move === undefined) {
                    continue;
                }
                // Self-loop check: if the only edge from this node
                // points back to itself, treat as a 1-cycle (impossible
                // given our up-front filter, but cheap defensiveness).
                const target = edges.get(docId);
                if (target === docId) {
                    await this.executeCycle([move]);
                } else {
                    await this.executeSimpleRename(move);
                }
            } else {
                const cycleMoves = scc
                    .map((id) => movesByDocId.get(id))
                    .filter(
                        (m): m is PlannedMove =>
                            m !== undefined && !skipped.has(m.record.documentId)
                    );
                if (cycleMoves.length === scc.length) {
                    await this.executeCycle(cycleMoves);
                } else {
                    // A member of the cycle was skipped — the cycle
                    // can't be resolved as a unit. Skip the rest; next
                    // pass tries again with whatever's still relevant.
                    this.logger.debug(
                        `Reconciler: cycle of ${scc.length} skipped because a ` +
                            `member dropped out; will retry next pass`
                    );
                }
            }
        }
    }

    private async executeSimpleRename(move: PlannedMove): Promise<void> {
        // Defense-in-depth: the queue's invariant says
        // `record.localPath !== undefined ⇒ byLocalPath.get(record.localPath) === record`.
        // If the byLocalPath index disagrees with the record we
        // captured when planning, the invariant was violated somewhere
        // upstream — the file at `move.from` belongs to a different
        // record now and renaming it would clobber that record's
        // content. Refuse the move; the next pass re-plans.
        const indexed = this.queue.byLocalPath.get(move.from);
        if (indexed !== move.record) {
            this.logger.warn(
                `Reconciler: refusing rename ${move.from} -> ${move.to} for ` +
                    `${move.record.documentId}: byLocalPath says ${move.from} ` +
                    `belongs to ${indexed?.documentId ?? "<no record>"} ` +
                    `(invariant violation upstream); skipping`
            );
            return;
        }
        // The target may have been freed by an earlier move in this
        // pass (a leaf we processed first). Re-check both source and
        // target before committing.
        try {
            if (!(await this.operations.exists(move.from))) {
                this.logger.debug(
                    `Reconciler: source ${move.from} vanished before rename; skipping`
                );
                return;
            }
        } catch (e) {
            this.logger.error(
                `Reconciler: existence check failed for ${move.from}: ${String(e)}`
            );
            return;
        }
        try {
            if (await this.operations.exists(move.to)) {
                if (this.queue.byLocalPath.get(move.to) !== undefined) {
                    // Slot got reclaimed by a tracked doc mid-pass —
                    // back off and retry next pass.
                    this.logger.debug(
                        `Reconciler: target ${move.to} reclaimed by another record ` +
                            `mid-pass; skipping`
                    );
                    return;
                }
                // Untracked file appeared; same reasoning as in
                // executeMoves' planning step. Defer.
                this.logger.debug(
                    `Reconciler: target ${move.to} now occupied by untracked file; skipping`
                );
                return;
            }
        } catch (e) {
            this.logger.error(
                `Reconciler: existence check failed for ${move.to}: ${String(e)}`
            );
            return;
        }

        try {
            await this.operations.move(move.from, move.to);
        } catch (e) {
            if (e instanceof FileNotFoundError) {
                this.logger.debug(
                    `Reconciler: rename ${move.from} -> ${move.to} hit FileNotFound; ` +
                        `will retry next pass`
                );
                return;
            }
            if (e instanceof FileAlreadyExistsError) {
                this.logger.debug(
                    `Reconciler: rename ${move.from} -> ${move.to} lost TOCTOU race ` +
                        `(target reclaimed between pre-check and rename); will retry next pass`
                );
                return;
            }
            this.logger.error(
                `Reconciler: rename ${move.from} -> ${move.to} failed: ${String(e)}`
            );
            return;
        }

        try {
            await this.queue.setLocalPath(move.record.documentId, move.to);
        } catch (e) {
            this.logger.error(
                `Reconciler: setLocalPath after rename failed for ${move.record.documentId}: ${String(e)}`
            );
            return;
        }
        this.logger.debug(
            `Reconciler: renamed ${move.record.documentId} from ${move.from} to ${move.to}`
        );
    }

    private async executeCycle(members: PlannedMove[]): Promise<void> {
        // Defense-in-depth: same invariant check as
        // `executeSimpleRename` but cycle-wide. If any member's `from`
        // slot no longer matches the planned record per byLocalPath,
        // abort the whole cycle — partial-cycle progress under a
        // shadowed-record race is the worst case (it can shuffle bytes
        // between the wrong docs).
        for (const member of members) {
            const indexed = this.queue.byLocalPath.get(member.from);
            if (indexed !== member.record) {
                this.logger.warn(
                    `Reconciler: refusing cycle: byLocalPath says ${member.from} ` +
                        `belongs to ${indexed?.documentId ?? "<no record>"} ` +
                        `but planned for ${member.record.documentId} ` +
                        `(invariant violation upstream); skipping cycle`
                );
                return;
            }
        }
        // Read every member's bytes first; we'll overwrite the target
        // slots with these. All reads happen before any write, so the
        // cycle is fully captured in memory before we start mutating
        // disk. If any read fails the whole cycle is aborted —
        // partial-cycle work is the riskiest case (it can leave docs
        // pointing at the wrong content).
        const contentByDocId = new Map<DocumentId, Uint8Array>();
        // We also need the pre-write content of each `to` slot for the
        // 3-way merge in `operations.write` — passing the freshly-read
        // disk bytes as `expectedContent` makes the merge resolve to a
        // clean overwrite (since `expected === current` at write time).
        const oldToContentByDocId = new Map<DocumentId, Uint8Array>();
        try {
            for (const member of members) {
                contentByDocId.set(
                    member.record.documentId,
                    await this.operations.read(member.from)
                );
            }
            // The `to` of each member is guaranteed to be the `from` of
            // some other member (it's a cycle). We've already read all
            // those `from`s, so reuse those reads.
            const fromToDocId = new Map<RelativePath, DocumentId>();
            for (const member of members) {
                fromToDocId.set(member.from, member.record.documentId);
            }
            for (const member of members) {
                const sourceDocId = fromToDocId.get(member.to);
                if (sourceDocId === undefined) {
                    throw new Error(
                        `Reconciler: cycle ${member.record.documentId} -> ${member.to} ` +
                            `has no member at ${member.to}; graph is not a true cycle`
                    );
                }
                const oldBytes = contentByDocId.get(sourceDocId);
                if (oldBytes === undefined) {
                    throw new Error(
                        `Reconciler: missing pre-read content for ${sourceDocId}`
                    );
                }
                oldToContentByDocId.set(member.record.documentId, oldBytes);
            }
        } catch (e) {
            this.logger.error(
                `Reconciler: cycle pre-read failed: ${String(e)}; aborting cycle`
            );
            return;
        }

        // Write-ahead marker so a crash mid-swap can be repaired on
        // next start. Recovery decides what's been written by hashing
        // each `from` slot — anything still matching `expectedHashOnFrom`
        // hasn't been overwritten yet.
        const legs: SwapLeg[] = [];
        try {
            for (const member of members) {
                const memberContent = contentByDocId.get(
                    member.record.documentId
                );
                if (memberContent === undefined) {
                    throw new Error(
                        `Reconciler: cycle member ${member.record.documentId} missing content`
                    );
                }
                legs.push({
                    documentId: member.record.documentId,
                    from: member.from,
                    to: member.to,
                    expectedHashOnFrom: await hash(memberContent)
                });
            }
        } catch (e) {
            this.logger.error(
                `Reconciler: cycle hashing failed: ${String(e)}; aborting cycle`
            );
            return;
        }

        const markerUuid = crypto.randomUUID();
        const markerPath = this.markerPathFor(markerUuid);
        const markerBytes = new TextEncoder().encode(
            JSON.stringify({ uuid: markerUuid, legs } satisfies SwapMarker)
        );
        try {
            // The marker path embeds a fresh uuid, so a FileAlreadyExistsError
            // is statistically impossible here.
            await this.operations.create(markerPath, markerBytes);
        } catch (e) {
            this.logger.error(
                `Reconciler: failed to write swap marker ${markerPath}: ${String(e)}; ` +
                    `aborting cycle`
            );
            return;
        }

        // Now apply the writes. Each leg overwrites the bytes at `to`
        // with the bytes that were at the cycle predecessor's `from`.
        // We pass the freshly-read pre-write content as
        // `expectedContent` so the 3-way merge inside `operations.write`
        // becomes a clean overwrite (no concurrent edits to merge with).
        // `operations.write` registers `expectUpdate` itself, so the
        // watcher swallows each leg's modify event.
        const writtenLegs: SwapLeg[] = [];
        for (const leg of legs) {
            const newBytes = contentByDocId.get(leg.documentId);
            const oldBytes = oldToContentByDocId.get(leg.documentId);
            if (newBytes === undefined || oldBytes === undefined) {
                this.logger.error(
                    `Reconciler: cycle leg ${leg.from} -> ${leg.to} missing ` +
                        `content; aborting cycle`
                );
                return;
            }
            try {
                await this.operations.write(leg.to, oldBytes, newBytes);
                writtenLegs.push(leg);
            } catch (e) {
                this.logger.error(
                    `Reconciler: cycle leg ${leg.from} -> ${leg.to} write failed: ` +
                        `${String(e)}; cycle is now in a half-applied state — recovery ` +
                        `marker ${markerPath} will roll forward on next start`
                );
                // Don't delete the marker — it's load-bearing for
                // recovery. The records' localPath assignments are
                // intentionally NOT updated for the failed leg or any
                // subsequent leg, so the next reconciler pass will
                // observe the same situation and re-plan.
                return;
            }
        }

        // Re-key records to their new localPaths. We do this AFTER
        // all writes succeeded; if a setLocalPath fails partway the
        // marker is still on disk and recovery covers it.
        for (const leg of writtenLegs) {
            try {
                await this.queue.setLocalPath(leg.documentId, leg.to);
            } catch (e) {
                this.logger.error(
                    `Reconciler: setLocalPath after cycle write failed for ` +
                        `${leg.documentId}: ${String(e)}`
                );
            }
        }

        try {
            await this.operations.delete(markerPath);
        } catch (e) {
            this.logger.warn(
                `Reconciler: failed to delete swap marker ${markerPath}: ${String(e)}; ` +
                    `next start's recovery will see it but find every leg already applied`
            );
        }
        this.logger.debug(
            `Reconciler: completed cycle of ${members.length} members`
        );
    }

    private async findSwapMarkerFiles(): Promise<RelativePath[]> {
        let entries: RelativePath[] = [];
        try {
            entries =
                await this.operations.listFilesRecursively(SWAP_MARKER_DIR);
        } catch (e) {
            if (e instanceof FileNotFoundError) {
                return [];
            }
            throw e;
        }
        return entries.filter((p) => {
            const name = p.split("/").pop() ?? "";
            return (
                name.startsWith(SWAP_MARKER_PREFIX) &&
                name.endsWith(SWAP_MARKER_SUFFIX)
            );
        });
    }

    private async recoverFromOneMarker(
        markerPath: RelativePath
    ): Promise<void> {
        const markerBytes = await this.operations.read(markerPath);
        const marker = this.parseSwapMarker(markerBytes);
        if (marker === undefined) {
            this.logger.error(
                `Reconciler: corrupt swap marker ${markerPath}; deleting`
            );
            try {
                await this.operations.delete(markerPath);
            } catch (deleteErr) {
                this.logger.error(
                    `Reconciler: failed to delete corrupt marker ${markerPath}: ${String(deleteErr)}`
                );
            }
            return;
        }

        this.logger.info(
            `Reconciler: recovering from interrupted swap ${marker.uuid} ` +
                `with ${marker.legs.length} legs`
        );

        // Recovery rules per leg:
        //   - hash(from) === expectedHashOnFrom — the swap was
        //     interrupted BEFORE this leg overwrote `to`. We need to
        //     write the source bytes to `to` AND update the record.
        //   - hash(from) differs (or `from` is missing) — this leg
        //     already ran (someone else's bytes are now at `from`,
        //     which means the cycle predecessor's leg ran too). Mark
        //     as already-applied for record bookkeeping.
        for (const leg of marker.legs) {
            let needsApply = false;
            try {
                if (await this.operations.exists(leg.from)) {
                    const fromBytes = await this.operations.read(leg.from);
                    const fromHash = await hash(fromBytes);
                    needsApply = fromHash === leg.expectedHashOnFrom;
                }
            } catch (e) {
                this.logger.error(
                    `Reconciler: hash check during recovery for ${leg.from} failed: ` +
                        `${String(e)}; skipping leg`
                );
                continue;
            }

            if (needsApply) {
                try {
                    const sourceBytes = await this.operations.read(leg.from);
                    // We don't know what (if anything) is at `to`. If
                    // it exists we want to overwrite. operations.write
                    // refuses if the file doesn't exist, so:
                    if (await this.operations.exists(leg.to)) {
                        const currentToBytes = await this.operations.read(
                            leg.to
                        );
                        await this.operations.write(
                            leg.to,
                            currentToBytes,
                            sourceBytes
                        );
                    } else {
                        await this.operations.create(leg.to, sourceBytes);
                    }
                } catch (e) {
                    this.logger.error(
                        `Reconciler: applying recovery leg ${leg.from} -> ${leg.to} ` +
                            `failed: ${String(e)}`
                    );
                    continue;
                }
            }

            // Whether we just applied or it was already applied,
            // update the record so its localPath matches the
            // post-swap state.
            try {
                const record = this.queue.getDocumentByDocumentId(
                    leg.documentId
                );
                if (record !== undefined) {
                    await this.queue.setLocalPath(leg.documentId, leg.to);
                }
            } catch (e) {
                this.logger.error(
                    `Reconciler: setLocalPath during recovery for ${leg.documentId} ` +
                        `failed: ${String(e)}`
                );
            }
        }

        try {
            await this.operations.delete(markerPath);
        } catch (e) {
            this.logger.error(
                `Reconciler: failed to delete swap marker ${markerPath} after recovery: ` +
                    String(e)
            );
        }
    }

    private markerPathFor(uuid: string): RelativePath {
        return `${SWAP_MARKER_DIR}/${SWAP_MARKER_PREFIX}${uuid}${SWAP_MARKER_SUFFIX}`;
    }

    /**
     * SCC decomposition over the move graph, returning components in
     * leaves-first order (so the caller can process leaves before
     * cycles, freeing target slots progressively).
     *
     * Exploits the fact that this is a *functional graph*: each node
     * has at most one outgoing edge (the doc whose slot we want). So
     * every non-trivial SCC is a single simple cycle; any non-cycle
     * node is its own singleton component. To detect cycles, walk
     * from each unvisited node following edges and mark the path; if
     * we hit a node on the current path, the segment from that node
     * to the current frontier is a cycle. If we hit a visited node
     * not on the current path (or a null), we just chain leaves.
     *
     * Skipped nodes are treated as having no outgoing edge (their
     * targets are blocked).
     */
    private tarjanSccs(
        edges: Map<DocumentId, DocumentId | null>,
        skipped: Set<DocumentId>
    ): DocumentId[][] {
        const allNodes = new Set<DocumentId>();
        for (const id of edges.keys()) {
            allNodes.add(id);
        }
        for (const id of skipped) {
            allNodes.add(id);
        }

        const visited = new Set<DocumentId>();
        const componentOf = new Map<DocumentId, number>();
        const sccs: DocumentId[][] = [];

        const edgeOf = (node: DocumentId): DocumentId | null => {
            if (skipped.has(node)) {
                return null;
            }
            return edges.get(node) ?? null;
        };

        for (const root of allNodes) {
            if (visited.has(root)) {
                continue;
            }

            // Walk forward marking the path until we hit a visited node
            // or a null. `pathIndex` lets us detect "did we land back on
            // our own path".
            const path: DocumentId[] = [];
            const pathIndex = new Map<DocumentId, number>();
            let cursor: DocumentId | null = root;

            while (
                cursor !== null &&
                !visited.has(cursor) &&
                !pathIndex.has(cursor)
            ) {
                pathIndex.set(cursor, path.length);
                path.push(cursor);
                cursor = edgeOf(cursor);
            }

            // We stopped because either (a) cursor is null, (b) cursor
            // is already visited (chain merges into an earlier-explored
            // subgraph — every node on `path` is its own singleton
            // component), or (c) cursor is on `path` itself — the
            // suffix of `path` from `pathIndex.get(cursor)` onward is a
            // cycle; the prefix is a tail of singletons.
            let cycleStart = path.length;
            if (cursor !== null) {
                const idx = pathIndex.get(cursor);
                if (idx !== undefined) {
                    cycleStart = idx;
                }
            }

            // Singletons in `path[0..cycleStart)`. Emit them in
            // leaves-first order: the deepest (closest to the cycle or
            // chain-end) is the leaf in the DAG of SCCs, so we emit
            // from the END of the prefix backward to get topo order
            // (children before parents).
            for (let i = cycleStart - 1; i >= 0; i--) {
                const node = path[i];
                visited.add(node);
                const componentId = sccs.length;
                componentOf.set(node, componentId);
                sccs.push([node]);
            }
            // Cycle (if any).
            if (cycleStart < path.length) {
                const cycleNodes = path.slice(cycleStart);
                const componentId = sccs.length;
                for (const node of cycleNodes) {
                    visited.add(node);
                    componentOf.set(node, componentId);
                }
                sccs.push(cycleNodes);
            }
        }

        // The order produced above is mostly leaves-first per chain,
        // but chains explored later may include singletons that merge
        // into earlier-emitted components. Re-sort by (component points
        // to anything? if so, target's component must come first). With
        // a functional graph this is equivalent to emitting any node
        // before the node it points to. Do a final stable topo sort.
        const componentTarget = new Map<number, number | null>();
        for (let cid = 0; cid < sccs.length; cid++) {
            // Pick a representative; in a functional-graph SCC, every
            // node's edge points either inside the SCC (cycle) or to
            // exactly one other SCC (singleton chain). For singletons
            // the representative's edge gives us the parent component.
            const [rep] = sccs[cid];
            const edge = edgeOf(rep);
            if (edge === null) {
                componentTarget.set(cid, null);
            } else {
                const targetCid = componentOf.get(edge);
                if (targetCid === undefined || targetCid === cid) {
                    componentTarget.set(cid, null);
                } else {
                    componentTarget.set(cid, targetCid);
                }
            }
        }

        // Topo-sort: emit a component only after its target has been
        // emitted.
        const emitted = new Set<number>();
        const ordered: DocumentId[][] = [];
        const tryEmit = (cid: number, stack: Set<number>): void => {
            if (emitted.has(cid)) {
                return;
            }
            if (stack.has(cid)) {
                return;
            } // shouldn't happen given functional-graph SCC contraction
            stack.add(cid);
            const target = componentTarget.get(cid) ?? null;
            if (target !== null) {
                tryEmit(target, stack);
            }
            stack.delete(cid);
            if (!emitted.has(cid)) {
                emitted.add(cid);
                ordered.push(sccs[cid]);
            }
        };
        for (let cid = 0; cid < sccs.length; cid++) {
            tryEmit(cid, new Set());
        }

        return ordered;
    }

    private parseSwapMarker(bytes: Uint8Array): SwapMarker | undefined {
        // Marker files are written by us (`writeSwapMarker`) and only
        // consumed here on startup recovery; the shape is closed. Treat
        // a parse failure as a corrupt marker.
        const parsed = tryParseSwapMarker(bytes);
        if (
            parsed === undefined ||
            typeof parsed.uuid !== "string" ||
            !Array.isArray(parsed.legs)
        ) {
            return undefined;
        }
        return parsed;
    }
}
