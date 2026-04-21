import type { DocumentRecord, RelativePath } from "./types";
import { SyncEventType } from "./types";
import type { Logger } from "../tracing/logger";
import { hash } from "../utils/hash";
import type { FileOperations } from "../file-operations/file-operations";
import { findMatchingFile } from "../utils/find-matching-file";
import { FileNotFoundError } from "../errors/file-not-found-error";
import type { SyncEventQueue } from "./sync-event-queue";

interface DocumentWithPath {
    path: RelativePath;
    record: DocumentRecord;
}

interface SyncInstruction {
    type: "update" | "create";
    relativePath: string;
    oldPath?: string;
}

interface OfflineChangeDetectorDeps {
    logger: Logger;
    operations: FileOperations;
    queue: SyncEventQueue;
}

/**
 * Scans the local filesystem and the document database to determine
 * which files were created, updated, moved, or deleted while the
 * client was offline, then enqueues the appropriate sync events.
 */
export async function scheduleOfflineChanges(
    deps: OfflineChangeDetectorDeps,
    enqueueCreate: (path: RelativePath) => void,
    enqueueUpdate: (args: { oldPath?: RelativePath; relativePath: RelativePath }) => void,
    enqueueDelete: (path: RelativePath) => void,
): Promise<void> {
    const { logger, operations, queue } = deps;

    const allLocalFiles = await operations.listFilesRecursively();
    logger.info(`Scheduling sync for ${allLocalFiles.length} local files`);

    queue.clear();

    const allDocuments = new Map(queue.allSettledDocuments());
    const locallyRenamedPaths = enqueueRenamedDocuments(deps, allDocuments);

    const deletedCandidates = await findLocallyDeletedFiles(operations, allDocuments);

    const instructions = await buildSyncInstructions(
        deps,
        allLocalFiles,
        locallyRenamedPaths,
        deletedCandidates,
    );

    // Enqueue deletes first
    for (const { path } of deletedCandidates) {
        logger.debug(`Document ${path} has been deleted locally, scheduling sync to delete it`);
        enqueueDelete(path);
    }

    // Then updates/moves
    for (const instruction of instructions) {
        if (instruction.type === "update") {
            enqueueUpdate({
                oldPath: instruction.oldPath,
                relativePath: instruction.relativePath,
            });
        }
    }

    // Creates last so the server can merge with existing documents
    for (const instruction of instructions) {
        if (instruction.type === "create") {
            enqueueCreate(instruction.relativePath);
        }
    }
}

function enqueueRenamedDocuments(
    { queue, logger }: OfflineChangeDetectorDeps,
    allDocuments: Map<RelativePath, DocumentRecord>,
): Set<RelativePath> {
    const locallyRenamedPaths = new Set<RelativePath>();

    for (const [path, record] of allDocuments) {
        const remoteRelPath = record.remoteRelativePath;
        const hasLocalRename = remoteRelPath !== undefined && remoteRelPath !== path;

        if (hasLocalRename) {
            queue.enqueue({ type: SyncEventType.SyncLocal, path });
            locallyRenamedPaths.add(path);
            logger.debug(`Document ${path} was renamed locally (from ${remoteRelPath}), scheduling sync`);
        }
    }

    return locallyRenamedPaths;
}

async function findLocallyDeletedFiles(
    operations: FileOperations,
    allDocuments: Map<RelativePath, DocumentRecord>,
): Promise<DocumentWithPath[]> {
    const result: DocumentWithPath[] = [];

    for (const [path, record] of allDocuments) {
        if (!(await operations.exists(path))) {
            result.push({ path, record });
        }
    }

    return result;
}

async function buildSyncInstructions(
    deps: OfflineChangeDetectorDeps,
    allLocalFiles: RelativePath[],
    locallyRenamedPaths: Set<RelativePath>,
    deletedCandidates: DocumentWithPath[],
): Promise<SyncInstruction[]> {
    const { logger, operations, queue } = deps;
    const instructions: SyncInstruction[] = [];

    for (const relativePath of allLocalFiles) {
        if (locallyRenamedPaths.has(relativePath)) {
            continue;
        }

        const existingRecord = queue.getSettledDocumentByPath(relativePath);

        if (existingRecord !== undefined) {
            const result = await handleExistingDocument(
                deps,
                relativePath,
                existingRecord,
                deletedCandidates,
            );
            if (result !== undefined) {
                if (result.updatedDeletedCandidates !== undefined) {
                    deletedCandidates = result.updatedDeletedCandidates;
                }
                if (result.instruction !== undefined) {
                    instructions.push(result.instruction);
                }
                continue;
            }

            logger.debug(
                `Document ${relativePath} might have been updated locally, scheduling sync to validate and update it`,
            );
            instructions.push({ type: "update", relativePath });
            continue;
        }

        const result = await handleNewFile(deps, relativePath, deletedCandidates);
        if (result.updatedDeletedCandidates !== undefined) {
            deletedCandidates = result.updatedDeletedCandidates;
        }
        instructions.push(result.instruction);
    }

    return instructions;
}

async function handleExistingDocument(
    { logger, operations }: OfflineChangeDetectorDeps,
    relativePath: RelativePath,
    existingRecord: DocumentRecord,
    deletedCandidates: DocumentWithPath[],
): Promise<
    | { instruction?: SyncInstruction; updatedDeletedCandidates?: DocumentWithPath[] }
    | undefined
> {
    if (deletedCandidates.length === 0) {
        return undefined;
    }

    let contentHash: string | undefined;
    try {
        const bytes = await operations.read(relativePath);
        contentHash = await hash(bytes);
    } catch (e) {
        if (e instanceof FileNotFoundError) return { instruction: undefined };
        throw e;
    }

    if (contentHash === existingRecord.remoteHash) {
        return undefined;
    }

    const originalFile = await findMatchingFile(contentHash, deletedCandidates);
    if (originalFile === undefined) {
        return undefined;
    }

    // This file was moved here from a different path, displacing the existing document
    const updatedDeletedCandidates = [
        ...deletedCandidates.filter((item) => item.path !== originalFile.path),
        { path: relativePath, record: existingRecord },
    ];

    logger.debug(
        `Document '${originalFile.path}' was moved to ${relativePath} (displacing existing document), scheduling sync to move it`,
    );

    return {
        instruction: { type: "update", oldPath: originalFile.path, relativePath },
        updatedDeletedCandidates,
    };
}

async function handleNewFile(
    { logger, operations }: OfflineChangeDetectorDeps,
    relativePath: RelativePath,
    deletedCandidates: DocumentWithPath[],
): Promise<{ instruction: SyncInstruction; updatedDeletedCandidates?: DocumentWithPath[] }> {
    let contentHash: string | undefined;
    try {
        const contentBytes = await operations.read(relativePath);
        contentHash = await hash(contentBytes);
    } catch (e) {
        if (e instanceof FileNotFoundError) {
            return { instruction: { type: "create", relativePath } };
        }
        throw e;
    }

    const originalFile = await findMatchingFile(contentHash, deletedCandidates);
    if (originalFile !== undefined) {
        const updatedDeletedCandidates = deletedCandidates.filter(
            (item) => item.path !== originalFile.path,
        );

        logger.debug(
            `Document '${originalFile.path}' was not found under its current path in the database but was found under a different path (${relativePath}), scheduling sync to move it`,
        );

        return {
            instruction: { type: "update", oldPath: originalFile.path, relativePath },
            updatedDeletedCandidates,
        };
    }

    logger.debug(`Document ${relativePath} not found in database, scheduling sync to create it`);
    return { instruction: { type: SyncEventType.Create, relativePath } };
}
