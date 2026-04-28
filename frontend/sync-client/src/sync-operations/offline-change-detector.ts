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
    const allDocuments = queue.allSettledDocuments();

    // A doc is "possibly deleted" only if it has no local file. Including
    // docs that still exist locally would queue a spurious delete alongside
    // the update below.
    const locallyPossiblyDeletedFiles: DocumentRecord[] = [];
    for (const record of allDocuments.values()) {
        if (!allLocalFiles.has(record.path)) {
            locallyPossiblyDeletedFiles.push(record);
        }
    }

    const locallyPossibleCreatedFiles: RelativePath[] = [];
    const syncedLocalFiles: RelativePath[] = [];

    for (const localFile of allLocalFiles) {
        if (allDocuments.has(localFile)) {
            syncedLocalFiles.push(localFile);
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
            logger.debug(
                `File ${path} might have been moved from ${matchingDeletedFile.path} while offline, scheduling sync to move it`
            );
            enqueueUpdate({
                oldPath: matchingDeletedFile.path,
                relativePath: path
            });
            removeFromArray(locallyPossiblyDeletedFiles, matchingDeletedFile);
            renamedPaths.add(path);
        }
    }

    for (const path of locallyPossibleCreatedFiles) {
        if (renamedPaths.has(path)) {continue;}

        logger.info(
            `File ${path} was created while offline, scheduling sync to create it`
        );

        enqueueCreate(path);
    }

    for (const item of locallyPossiblyDeletedFiles) {
        logger.info(
            `File ${item.path} was deleted while offline, scheduling sync to delete it`
        );
        enqueueDelete(item.path);
    }

    for (const path of syncedLocalFiles) {
        logger.info(
            `File ${path} may have been updated while offline, scheduling sync to update it`
        );
        enqueueUpdate({ relativePath: path });
    }
}
