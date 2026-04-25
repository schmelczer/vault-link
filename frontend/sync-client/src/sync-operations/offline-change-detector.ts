import type { DocumentRecord, DocumentWithPath, RelativePath } from "./types";
import { SyncEventType } from "./types";
import type { Logger } from "../tracing/logger";
import { hash } from "../utils/hash";
import type { FileOperations } from "../file-operations/file-operations";
import { findMatchingFile } from "../utils/find-matching-file";
import { FileNotFoundError } from "../errors/file-not-found-error";
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
    enqueueUpdate: (args: { oldPath?: RelativePath; relativePath: RelativePath }) => void,
    enqueueDelete: (path: RelativePath) => void,
): Promise<void> {
    const allLocalFiles = await operations.listFilesRecursively();
    logger.info(`Scheduling sync for ${allLocalFiles.length} local files`);
    const allDocuments = queue.allSettledDocuments();

    const locallyPossiblyDeletedFiles: DocumentWithPath[] = [];

    for (const [path, record] of allDocuments.entries()) {
        if (
            record !== undefined
        ) {
            locallyPossiblyDeletedFiles.push({ path, record });
        }
    }

    const locallyPossibleCreatedFiles: RelativePath[] = [];
    const syncedLocalFiles: RelativePath[] = [];

    for (const localFile of allLocalFiles) {
        if (allDocuments.has(localFile)
        ) {
            syncedLocalFiles.push(localFile);
        } else {
            locallyPossibleCreatedFiles.push(localFile);
        }
    }

    for (const path of locallyPossibleCreatedFiles) {
        const content = await operations.read(path);
        const contentHash = await hash(content);

        const matchingDeletedFile = await findMatchingFile(contentHash, locallyPossiblyDeletedFiles);
        if (matchingDeletedFile !== undefined) {
            logger.debug(
                `File ${path} might have been moved from ${matchingDeletedFile.path} while offline, scheduling sync to move it`,
            );
            enqueueUpdate({ oldPath: matchingDeletedFile.path, relativePath: path });
            removeFromArray(locallyPossiblyDeletedFiles, matchingDeletedFile);
            removeFromArray(locallyPossibleCreatedFiles, path);
        }
    }

    for (const path of locallyPossibleCreatedFiles) {
        logger.debug(`File ${path} was created while offline, scheduling sync to create it`);
        enqueueCreate(path);
    }

    for (const item of locallyPossiblyDeletedFiles) {
        enqueueDelete(item.path);
    }

    for (const path of syncedLocalFiles) {
        enqueueUpdate({ relativePath: path });
    }
}
