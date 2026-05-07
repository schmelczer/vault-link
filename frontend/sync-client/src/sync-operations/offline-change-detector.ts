import type { DocumentRecord, RelativePath } from "./types";
import type { Logger } from "../tracing/logger";
import { hash } from "../utils/hash";
import type { FileOperations } from "../file-operations/file-operations";
import { findMatchingFile } from "../utils/find-matching-file";
import type { SyncEventQueue } from "./sync-event-queue";
import { removeFromArray } from "../utils/remove-from-array";

/**
 * Scans the local filesystem and the document database to determine
 * which files were created, updated, moved, or deleted while the
 * client was offline, then enqueues the appropriate sync events.
 *
 * Placement-pending records (`localPath === undefined`) are deliberately
 * NOT bound to local files at the same `remoteRelativePath` here. The
 * persisted byDocId snapshot can be stale — a doc's server-side path
 * may have changed since the last save, so binding by stored path would
 * fold an unrelated user file into a moved doc and silently corrupt it.
 * Local files at those paths fall through to the LocalCreate flow below;
 * the server's create_document handler dedupes by path+freshness when
 * the doc really is at that path, and otherwise creates a new doc that
 * the reconciler places correctly once catch-up updates the stale
 * record's `remoteRelativePath`.
 */
export async function scheduleOfflineChanges(
    logger: Logger,
    operations: FileOperations,
    queue: SyncEventQueue,
    enqueueCreate: (path: RelativePath) => void,
    enqueueUpdate: (args: {
        oldPath?: RelativePath;
        relativePath: RelativePath;
    }) => void,
    enqueueDelete: (path: RelativePath) => void
): Promise<void> {
    const allLocalFiles = new Set(await operations.listFilesRecursively());
    logger.info(`Scheduling sync for ${allLocalFiles.size} local files`);
    // `allSettledDocuments()` skips records with `localPath === undefined`
    // — those have no local file by definition and don't participate in
    // the disk-vs-record diff. The reconciler will place them on its
    // next pass.
    const allDocuments = queue.allSettledDocuments();

    // A doc is "possibly deleted" only if it has no local file. Including
    // docs that still exist locally would queue a spurious delete alongside
    // the update below.
    const locallyPossiblyDeletedFiles: DocumentRecord[] = [];
    for (const record of allDocuments.values()) {
        // `localPath` is guaranteed non-undefined for entries in
        // `allSettledDocuments()`, but narrow explicitly for the type
        // checker (and so a future change to that helper doesn't
        // silently break this loop).
        if (
            record.localPath !== undefined &&
            !allLocalFiles.has(record.localPath)
        ) {
            locallyPossiblyDeletedFiles.push(record);
        }
    }

    const locallyPossibleCreatedFiles: RelativePath[] = [];
    const syncedLocalFiles: RelativePath[] = [];

    for (const localFile of allLocalFiles) {
        if (allDocuments.has(localFile)) {
            syncedLocalFiles.push(localFile);
        } else if (queue.hasPendingCreateForPath(localFile)) {
            // A LocalCreate for this path is still in flight (no
            // record yet — its docId is a Promise). Re-enqueueing
            // would fire a second HTTP create that the server then
            // deconflicts to a sibling path, leaving the same bytes
            // in two docs. Skip; the in-flight create owns this slot.
            continue;
        } else {
            locallyPossibleCreatedFiles.push(localFile);
        }
    }

    const renamedPaths = new Set<RelativePath>();
    for (const path of locallyPossibleCreatedFiles) {
        const content = await operations.read(path);
        const contentHash = await hash(content);

        const matchingDeletedFile = await findMatchingFile(
            contentHash,
            locallyPossiblyDeletedFiles
        );
        if (matchingDeletedFile !== undefined) {
            // localPath is guaranteed defined for records in
            // locallyPossiblyDeletedFiles (we filtered above).
            const oldPath = matchingDeletedFile.localPath;
            if (oldPath === undefined) {
                continue;
            }
            logger.debug(
                `File ${path} might have been moved from ${oldPath} while offline, scheduling sync to move it`
            );
            enqueueUpdate({
                oldPath,
                relativePath: path
            });
            removeFromArray(locallyPossiblyDeletedFiles, matchingDeletedFile);
            renamedPaths.add(path);
        }
    }

    for (const path of locallyPossibleCreatedFiles) {
        if (renamedPaths.has(path)) {
            continue;
        }

        logger.info(
            `File ${path} was created while offline, scheduling sync to create it`
        );

        enqueueCreate(path);
    }

    for (const item of locallyPossiblyDeletedFiles) {
        if (item.localPath === undefined) {
            continue;
        }
        logger.info(
            `File ${item.localPath} was deleted while offline, scheduling sync to delete it`
        );
        enqueueDelete(item.localPath);
    }

    for (const path of syncedLocalFiles) {
        const record = allDocuments.get(path);
        if (
            record !== undefined &&
            record.localPath !== undefined &&
            record.localPath !== record.remoteRelativePath &&
            !allLocalFiles.has(record.remoteRelativePath) &&
            queue.byLocalPath.get(record.remoteRelativePath) === undefined
        ) {
            // Lost local-rename recovery. The record's `localPath`
            // (where the user has the file now) and
            // `remoteRelativePath` (where the server still thinks it
            // lives) disagree, which means a queued user-rename's
            // LocalUpdate never reached the server before the queue
            // was wiped (typically a sync reset). Without this
            // branch the next `enqueueUpdate({ relativePath: path })`
            // is a content-only update — server keeps the doc at the
            // old path, the user's file at the new path orphans, and
            // other clients never see the rename. Replay the rename
            // by restoring the OLD localPath so the queue's enqueue
            // can find the record by `oldPath`, then enqueueUpdate
            // moves it back to the new path with `isUserRename`.
            // Only fires when the old slot is genuinely empty
            // (neither on disk nor claimed by another tracked
            // record) — otherwise the rename target is occupied and
            // we'd be confusing the byLocalPath index.
            const oldPath = record.remoteRelativePath;
            const newPath = record.localPath;
            logger.info(
                `Lost local rename detected: doc ${record.documentId} at ${oldPath} (server) vs ${newPath} (local); replaying rename to server`
            );
            await queue.setLocalPath(record.documentId, oldPath);
            enqueueUpdate({ oldPath, relativePath: newPath });
            continue;
        }
        logger.info(
            `File ${path} may have been updated while offline, scheduling sync to update it`
        );
        enqueueUpdate({ relativePath: path });
    }
}
