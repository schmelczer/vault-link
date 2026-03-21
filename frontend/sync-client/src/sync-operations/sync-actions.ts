import type {
    VirtualFilesystem,
    TrackedDocument,
    PendingDocument,
    DeletedLocallyDocument,
    VirtualDocument
} from "../persistence/vfs";
import type { SyncService } from "../services/sync-service";
import type { FileOperations } from "../file-operations/file-operations";
import type { Logger } from "../tracing/logger";
import type {
    CommonHistoryEntry,
    SyncCreateDetails,
    SyncDeleteDetails,
    SyncDetails,
    SyncHistory,
    SyncMovedDetails,
    SyncUpdateDetails
} from "../tracing/sync-history";
import { SyncStatus, SyncType } from "../tracing/sync-history";
import type { FixedSizeDocumentCache } from "../utils/data-structures/fix-sized-cache";
import type { ServerConfig } from "../services/server-config";
import type { Settings } from "../persistence/settings";
import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";
import type { DocumentVersion } from "../services/types/DocumentVersion";
import type { DocumentUpdateResponse } from "../services/types/DocumentUpdateResponse";
import type { RelativePath } from "../persistence/database";

import { diff } from "reconcile-text";
import { EMPTY_HASH, hash } from "../utils/hash";
import { base64ToBytes } from "byte-base64";
import { FileNotFoundError } from "../errors/file-not-found-error";
import { HttpClientError } from "../errors/http-client-error";
import { SyncResetError } from "../errors/sync-reset-error";
import { globsToRegexes } from "../utils/globs-to-regexes";
import { isFileTypeMergable } from "../utils/is-file-type-mergable";
import { isBinary } from "../utils/is-binary";
import { decodeText } from "../utils/decode-text";

// ---------------------------------------------------------------------------
// Dependency bag passed to every action
// ---------------------------------------------------------------------------

export interface SyncDeps {
    logger: Logger;
    vfs: VirtualFilesystem;
    syncService: SyncService;
    operations: FileOperations;
    history: SyncHistory;
    contentCache: FixedSizeDocumentCache;
    serverConfig: ServerConfig;
    settings: Settings;
}

// ---------------------------------------------------------------------------
// Deconflict‑suffix helpers (extracted from UnrestrictedSyncer)
// ---------------------------------------------------------------------------

const DECONFLICT_SUFFIX = / \(\d+\)$/;

/**
 * Check if `candidate` is a path-deconflicted variant of `basePath`.
 * e.g., "file (2).bin" is a variant of "file.bin", but "doc.bin" is not.
 */
export function isDeconflictedVariant(
    candidate: string,
    basePath: string
): boolean {
    const stripExt = (p: string): [string, string] => {
        const lastDot = p.lastIndexOf(".");
        const lastSlash = p.lastIndexOf("/");
        if (lastDot > lastSlash + 1) {
            return [p.substring(0, lastDot), p.substring(lastDot)];
        }
        return [p, ""];
    };
    const [candidateStem, candidateExt] = stripExt(candidate);
    const [baseStem, baseExt] = stripExt(basePath);
    if (candidateExt !== baseExt) return false;
    const strippedStem = candidateStem.replace(DECONFLICT_SUFFIX, "");
    return strippedStem === baseStem;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function getHistoryEntryForSkippedOversizedFile(
    sizeInBytes: number,
    relativePath: RelativePath,
    settings: Settings
): CommonHistoryEntry | undefined {
    const { maxFileSizeMB } = settings.getSettings();
    const maxFileSizeBytes = maxFileSizeMB * 1024 * 1024;
    if (sizeInBytes > maxFileSizeBytes) {
        const sizeInMB = (sizeInBytes / 1024 / 1024).toFixed(1);
        return {
            status: SyncStatus.SKIPPED,
            details: {
                type: SyncType.SKIPPED,
                relativePath
            },
            message: `File size of ${sizeInMB} MB exceeds the maximum file size limit of ${maxFileSizeMB} MB`
        };
    }
}

async function updateCache(
    contentCache: FixedSizeDocumentCache,
    serverConfig: ServerConfig,
    updateId: number,
    contentBytes: Uint8Array,
    filePath: RelativePath
): Promise<void> {
    if (
        isFileTypeMergable(
            filePath,
            (await serverConfig.getConfig()).mergeableFileExtensions
        ) &&
        !isBinary(contentBytes)
    ) {
        contentCache.put(updateId, contentBytes);
    }
}

// Cached ignore-pattern regexes, rebuilt when settings change.
let cachedIgnorePatterns: RegExp[] | undefined;
let cachedSettingsRef: Settings | undefined;

function getIgnorePatterns(deps: SyncDeps): RegExp[] {
    if (cachedSettingsRef !== deps.settings || cachedIgnorePatterns === undefined) {
        cachedIgnorePatterns = globsToRegexes(
            deps.settings.getSettings().ignorePatterns,
            deps.logger
        );
        cachedSettingsRef = deps.settings;
    }
    return cachedIgnorePatterns;
}

// ---------------------------------------------------------------------------
// executeSync wrapper (error handling, ignore patterns, size checks)
// ---------------------------------------------------------------------------

async function executeSync<T>(
    deps: SyncDeps,
    details: SyncDetails,
    fn: () => Promise<T>
): Promise<T | undefined> {
    if (!deps.settings.getSettings().isSyncEnabled) {
        deps.logger.info(
            `Skipping sync operation for file '${details.relativePath}' because sync is disabled`
        );
        return;
    }

    for (const pattern of getIgnorePatterns(deps)) {
        if (pattern.test(details.relativePath)) {
            deps.logger.debug(
                `File '${details.relativePath}' is ignored by the ignore pattern: ${pattern}`
            );
            return;
        }
    }

    try {
        // Only check the size of files which already exist locally.
        if (await deps.operations.exists(details.relativePath)) {
            const sizeInBytes = await deps.operations.getFileSize(
                details.relativePath
            );
            const historyEntryForSkippedOversizedFile =
                getHistoryEntryForSkippedOversizedFile(
                    sizeInBytes,
                    details.relativePath,
                    deps.settings
                );
            if (historyEntryForSkippedOversizedFile !== undefined) {
                deps.history.addHistoryEntry(
                    historyEntryForSkippedOversizedFile
                );
                return;
            }
        }

        return await fn();
    } catch (e) {
        if (e instanceof FileNotFoundError) {
            deps.logger.info(
                `Skiping file '${details.relativePath}' because it no longer exists when trying to ${details.type.toLocaleLowerCase()} it`
            );
            return;
        }
        if (e instanceof SyncResetError) {
            deps.logger.info(
                `Interrupting sync operation because of a reset`
            );
            return;
        } else {
            deps.history.addHistoryEntry({
                status: SyncStatus.ERROR,
                details,
                message: `Failed to sync file '${details.relativePath}' because of ${e} when trying to ${details.type.toLocaleLowerCase()} it`
            });
            throw e;
        }
    }
}

// ---------------------------------------------------------------------------
// applyRemoteDeleteLocally
// ---------------------------------------------------------------------------

async function applyRemoteDeleteLocally(
    deps: SyncDeps,
    doc: VirtualDocument,
    response: DocumentVersion | DocumentUpdateResponse
): Promise<void> {
    await deps.operations.delete(doc.relativePath);

    // deleteLocally transitions tracked → deleted-locally (new object in
    // documentIdIndex). confirmDelete then removes it entirely. No need
    // to call updateTracked — the delete already captures the server state.
    deps.vfs.deleteLocally(doc.relativePath);

    if (doc.state === "tracked") {
        deps.vfs.confirmDelete(response.documentId);
    }
    // For pending or deleted-locally, deleteLocally already handled removal

    deps.vfs.addSeenUpdateId(response.vaultUpdateId);
}

// ---------------------------------------------------------------------------
// applyServerResponse (extracted from handleMaybeMergingResponse)
// ---------------------------------------------------------------------------

export async function applyServerResponse(
    deps: SyncDeps,
    doc: PendingDocument | TrackedDocument,
    response: DocumentVersion | DocumentUpdateResponse,
    contentHash: string,
    originalRelativePath: string,
    originalContentBytes: Uint8Array,
    isCreate?: boolean
): Promise<void> {
    // Derive at entry before any metadata mutation. True when
    // resolveIdempotencyKeys assigned a documentId (serverVersion 0)
    // and we retried the create — the server returned the existing version.
    const isIdempotentCreateReturn =
        isCreate === true &&
        doc.state === "tracked" &&
        doc.serverVersion === 0;

    // Check if the document was deleted locally
    const currentDoc = deps.vfs.getByPath(doc.relativePath);
    if (currentDoc === undefined) {
        // Path was removed from pathIndex (deleted locally)
        deps.logger.info(
            `Document ${doc.relativePath} has been deleted before we could finish updating it`
        );
        // For pending docs deleted during create: assign metadata so the
        // pending delete can inform the server
        if (doc.state === "pending") {
            const conflict = deps.vfs.getByDocumentId(response.documentId);
            if (conflict !== undefined && conflict !== doc) {
                deps.vfs.remove(doc);
            } else {
                // Transition to tracked so delete can be sent to server
                deps.vfs.confirmCreate(
                    doc.idempotencyKey,
                    response.documentId,
                    response.vaultUpdateId,
                    contentHash,
                    response.relativePath
                );
                // Then delete locally
                deps.vfs.deleteLocally(doc.relativePath);
            }
        }
        deps.vfs.addSeenUpdateId(response.vaultUpdateId);
        return;
    }

    const currentServerVersion =
        doc.state === "tracked" ? doc.serverVersion : 0;

    if (currentServerVersion > response.vaultUpdateId) {
        deps.logger.debug(
            `Document ${doc.relativePath} is already more up to date than the fetched version`
        );
        deps.vfs.addSeenUpdateId(response.vaultUpdateId);
        return;
    }

    if (response.isDeleted) {
        return applyRemoteDeleteLocally(deps, doc, response);
    }

    let actualPath = doc.relativePath;

    if (isCreate) {
        // The server returns a merging update for a document ID that
        // may already exist locally (at another path). Remove the stale
        // database record so no two records share the same documentId.
        const staleDoc = deps.vfs.ensureUniqueDocumentId(
            response.documentId,
            doc
        );
        if (staleDoc !== undefined) {
            deps.logger.info(
                `Removed stale database record at ${staleDoc.relativePath} — ` +
                    `server merged documentId ${response.documentId} into ${doc.relativePath}. ` +
                    `File left on disk for next sync cycle.`
            );
        }
    }

    // A document's documentId should never change once assigned.
    if (
        doc.state === "tracked" &&
        doc.documentId !== response.documentId
    ) {
        deps.logger.info(
            `Document ${doc.relativePath} already has documentId ${doc.documentId}, ` +
                `but response has documentId ${response.documentId}. Ignoring response to prevent documentId corruption.`
        );
        deps.vfs.addSeenUpdateId(response.vaultUpdateId);
        return;
    }

    // Handle path change from server (can't happen on creation path since
    // merging responses only occur when a document already exists remotely)
    if (response.relativePath !== originalRelativePath) {
        if (isIdempotentCreateReturn) {
            // The server knows this document at its original creation path,
            // but the user renamed the file locally while offline. Don't
            // revert the rename — keep the local path and let the next sync
            // cycle push the rename to the server.
            deps.logger.info(
                `Idempotent create return: keeping local path ${doc.relativePath} ` +
                    `instead of reverting to server path ${response.relativePath}`
            );
        } else {
            actualPath = response.relativePath;
            // Update remote relative path
            if (doc.state === "tracked") {
                doc.remoteRelativePath = response.relativePath;
            }
            await deps.operations.move(
                doc.relativePath,
                response.relativePath
            ); // this can throw FileNotFoundError

            // Update the VFS path to match the new location
            deps.vfs.move(doc.relativePath, response.relativePath);
        }
    }

    if (!("type" in response) || response.type === "MergingUpdate") {
        const responseBytes = base64ToBytes(response.contentBase64);

        // Write file BEFORE updating metadata so that if the write fails,
        // metadata doesn't point to a version whose content was never written.
        await deps.operations.write(
            actualPath,
            originalContentBytes,
            responseBytes
        );

        // Re-read and re-hash after write because the 3-way merge in
        // operations.write() may produce content different from responseBytes.
        const actualContent = await deps.operations.read(actualPath);
        const actualHash = hash(actualContent);

        // Transition pending -> tracked or update tracked metadata
        if (doc.state === "pending") {
            deps.vfs.confirmCreate(
                doc.idempotencyKey,
                response.documentId,
                response.vaultUpdateId,
                actualHash,
                response.relativePath
            );
        } else {
            deps.vfs.updateTracked(
                response.documentId,
                response.vaultUpdateId,
                actualHash,
                response.relativePath
            );
        }

        // Cache the SERVER's content (responseBytes), not the local
        // content (actualContent).
        await updateCache(
            deps.contentCache,
            deps.serverConfig,
            response.vaultUpdateId,
            responseBytes,
            actualPath
        );

        // If the local file diverged from the server after merge, set the
        // metadata hash to the SERVER's hash so the next sync cycle detects
        // the mismatch and uploads the local content.
        const serverMergedHash = hash(responseBytes);
        if (actualHash !== serverMergedHash) {
            deps.logger.info(
                `File ${actualPath} diverged from server after merge ` +
                    `(local: ${actualHash}, server: ${serverMergedHash}), ` +
                    `will re-sync on next cycle`
            );
            // Re-fetch the current doc from VFS since confirmCreate may
            // have replaced the pending doc with a tracked one.
            const trackedDoc = deps.vfs.getByDocumentId(response.documentId);
            if (trackedDoc?.state === "tracked") {
                deps.vfs.updateTracked(
                    trackedDoc.documentId,
                    trackedDoc.serverVersion,
                    serverMergedHash,
                    trackedDoc.remoteRelativePath
                );
            }
        }
    } else if (isCreate === true) {
        // FastForwardUpdate from an idempotent create return — the
        // server may have returned the original version whose content
        // differs from what we sent. Always fetch the server content
        // to ensure the cache is consistent.

        // Apply server-side path if it differs and this is NOT an
        // idempotent create return (where we keep the local path).
        if (
            response.relativePath !== actualPath &&
            !isIdempotentCreateReturn
        ) {
            if (doc.state === "tracked") {
                doc.remoteRelativePath = response.relativePath;
            }
            await deps.operations.move(
                doc.relativePath,
                response.relativePath
            );
            deps.vfs.move(doc.relativePath, response.relativePath);
            actualPath = response.relativePath;
        }

        const serverContent =
            await deps.syncService.getDocumentVersionContent({
                documentId: response.documentId,
                vaultUpdateId: response.vaultUpdateId
            });

        if (doc.state === "pending") {
            deps.vfs.confirmCreate(
                doc.idempotencyKey,
                response.documentId,
                response.vaultUpdateId,
                hash(serverContent),
                response.relativePath
            );
        } else {
            deps.vfs.updateTracked(
                response.documentId,
                response.vaultUpdateId,
                hash(serverContent),
                response.relativePath
            );
        }

        await updateCache(
            deps.contentCache,
            deps.serverConfig,
            response.vaultUpdateId,
            serverContent,
            actualPath
        );
    } else {
        // FastForwardUpdate — the server accepted our content as-is.
        if (doc.state === "pending") {
            deps.vfs.confirmCreate(
                doc.idempotencyKey,
                response.documentId,
                response.vaultUpdateId,
                contentHash,
                response.relativePath
            );
        } else {
            deps.vfs.updateTracked(
                response.documentId,
                response.vaultUpdateId,
                contentHash,
                response.relativePath
            );
        }

        await updateCache(
            deps.contentCache,
            deps.serverConfig,
            response.vaultUpdateId,
            originalContentBytes,
            actualPath
        );
    }

    deps.vfs.addSeenUpdateId(response.vaultUpdateId);
}

// ---------------------------------------------------------------------------
// 1. executeSyncCreate
// ---------------------------------------------------------------------------

export async function executeSyncCreate(
    deps: SyncDeps,
    doc: PendingDocument
): Promise<void> {
    const createDetails: SyncCreateDetails = {
        type: SyncType.CREATE,
        relativePath: doc.relativePath
    };

    await executeSync(deps, createDetails, async () => {
        // For pending creates that were system-displaced by ensureClearPath
        // (e.g., "file.bin" -> "file (1).bin"), send the create to the
        // ORIGINAL path so the server handles deconfliction.
        const originalRelativePath =
            doc.originalCreationPath !== doc.relativePath &&
            isDeconflictedVariant(
                doc.relativePath,
                doc.originalCreationPath
            )
                ? doc.originalCreationPath
                : doc.relativePath;

        let contentBytes = await deps.operations.read(
            doc.relativePath
        ); // this can throw FileNotFoundError
        let contentHash = hash(contentBytes);

        const response = await deps.syncService.create({
            relativePath: originalRelativePath,
            contentBytes,
            idempotencyKey: doc.idempotencyKey
        });

        await applyServerResponse(
            deps,
            doc,
            response,
            contentHash,
            originalRelativePath,
            contentBytes,
            true
        );

        deps.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: {
                type: SyncType.CREATE,
                relativePath: doc.relativePath
            },
            message: `Successfully created file '${doc.relativePath}' on the server`
        });

        // The file may have been modified while the create request
        // was in-flight. Re-read and check: if the disk content
        // differs from what the metadata hash says, immediately
        // upload the new content as an update.
        const trackedDoc = deps.vfs.getByDocumentId(response.documentId);
        if (
            trackedDoc?.state === "tracked"
        ) {
            try {
                const freshBytes = await deps.operations.read(
                    trackedDoc.relativePath
                );
                const freshHash = hash(freshBytes);
                if (freshHash !== trackedDoc.localHash) {
                    deps.logger.info(
                        `File ${trackedDoc.relativePath} was modified during create, uploading follow-up update`
                    );
                    // Re-use the update path with fresh content
                    contentBytes = freshBytes;
                    contentHash = freshHash;
                    // Fall through to the update below
                } else {
                    return;
                }
            } catch {
                // File may have been deleted — nothing to update
                return;
            }

            // Inline update for in-flight edits detected after create
            await executeSyncUpdateInner(
                deps,
                trackedDoc,
                contentBytes,
                contentHash,
                originalRelativePath,
                undefined,
                false
            );
        }
    });
}

// ---------------------------------------------------------------------------
// 2. executeSyncUpdate
// ---------------------------------------------------------------------------

export async function executeSyncUpdate(
    deps: SyncDeps,
    doc: TrackedDocument,
    oldPath?: string
): Promise<void> {
    await executeSyncUpdateFull(deps, doc, oldPath, false);
}

/**
 * Full create-or-update path. When `force` is true, the update is sent
 * even when the local hash matches (used for remote-update processing).
 */
export async function executeSyncUpdateFull(
    deps: SyncDeps,
    doc: TrackedDocument,
    oldPath?: string,
    force = false
): Promise<void> {
    const updateDetails:
        | SyncUpdateDetails
        | SyncMovedDetails =
        oldPath !== undefined
            ? {
                type: SyncType.MOVE,
                relativePath: doc.relativePath,
                movedFrom: oldPath
            }
            : {
                type: SyncType.UPDATE,
                relativePath: doc.relativePath
            };

    await executeSync(deps, updateDetails, async () => {
        const originalRelativePath = doc.relativePath;

        let contentBytes = await deps.operations.read(
            doc.relativePath
        ); // this can throw FileNotFoundError
        let contentHash = hash(contentBytes);

        // If parentVersionId is 0, resolveIdempotencyKeys assigned a
        // documentId but hasn't synced yet. Treat as a create retry.
        if (doc.serverVersion === 0) {
            // Use the preserved idempotency key so the server can
            // deduplicate if the original create already succeeded.
            const response = await deps.syncService.create({
                relativePath: originalRelativePath,
                contentBytes,
                idempotencyKey: doc.idempotencyKey
            });

            await applyServerResponse(
                deps,
                doc,
                response,
                contentHash,
                originalRelativePath,
                contentBytes,
                true
            );

            // Check for in-flight edits
            const updatedDoc = deps.vfs.getByDocumentId(response.documentId);
            if (
                updatedDoc?.state === "tracked"
            ) {
                try {
                    const freshBytes = await deps.operations.read(
                        updatedDoc.relativePath
                    );
                    const freshHash = hash(freshBytes);
                    if (freshHash !== updatedDoc.localHash) {
                        deps.logger.info(
                            `File ${updatedDoc.relativePath} was modified during create, uploading follow-up update`
                        );
                        contentBytes = freshBytes;
                        contentHash = freshHash;
                    } else {
                        return;
                    }
                } catch {
                    return;
                }

                await executeSyncUpdateInner(
                    deps,
                    updatedDoc,
                    contentBytes,
                    contentHash,
                    originalRelativePath,
                    undefined,
                    false
                );
            }
            return;
        }

        let response: DocumentVersion | DocumentUpdateResponse | undefined =
            undefined;

        {
            const areThereLocalChanges =
                doc.localHash !== contentHash ||
                oldPath !== undefined;

            if (areThereLocalChanges) {
                response = await executeSyncUpdateSendChanges(
                    deps,
                    doc,
                    contentBytes
                );
            } else {
                if (!force) {
                    deps.logger.debug(
                        `File hash of ${doc.relativePath} matches with last synced version and the path hasn't changed; no need to sync`
                    );
                    return;
                }

                // Force path: sync remotely updated files which have no local changes.
                response = await deps.syncService.get({
                    documentId: doc.documentId
                });

                // If the server's content matches the local content,
                // just update metadata without moving the file.
                const serverBytes = base64ToBytes(
                    response.contentBase64
                );
                if (hash(serverBytes) === contentHash) {
                    // If the server renamed the document, apply the rename
                    // locally. Skip the rename only when the local path is
                    // a deconflicted variant of the server path.
                    if (
                        response.relativePath !==
                            doc.relativePath &&
                        !isDeconflictedVariant(
                            doc.relativePath,
                            response.relativePath
                        )
                    ) {
                        try {
                            await deps.operations.move(
                                doc.relativePath,
                                response.relativePath
                            );
                        } catch {
                            return;
                        }
                    }

                    deps.vfs.updateTracked(
                        response.documentId,
                        response.vaultUpdateId,
                        contentHash,
                        response.relativePath
                    );
                    await updateCache(
                        deps.contentCache,
                        deps.serverConfig,
                        response.vaultUpdateId,
                        serverBytes,
                        doc.relativePath
                    );
                    deps.vfs.addSeenUpdateId(
                        response.vaultUpdateId
                    );
                    return;
                }
            }

            await applyServerResponse(
                deps,
                doc,
                response,
                contentHash,
                originalRelativePath,
                contentBytes
            );
        }

        if (!("type" in response) || response.type === "MergingUpdate") {
            if (!force) {
                deps.history.addHistoryEntry({
                    status: SyncStatus.SUCCESS,
                    details: updateDetails,
                    message: `The file we updated had been updated remotely, so we downloaded the merged version`
                });
                return;
            }
        }

        const actualUpdateDetails: SyncUpdateDetails | SyncMovedDetails =
            oldPath !== undefined ||
                response.relativePath !== originalRelativePath
                ? {
                    type: SyncType.MOVE,
                    relativePath: response.relativePath,
                    movedFrom: originalRelativePath
                }
                : {
                    type: SyncType.UPDATE,
                    relativePath: response.relativePath
                };

        if (!response.isDeleted) {
            deps.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: actualUpdateDetails,
                message: `Successfully downloaded remotely updated file from the server`,
                author: response.userId,
                timestamp: new Date(response.updatedDate)
            });
        } else {
            deps.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: {
                    type: SyncType.DELETE,
                    relativePath: doc.relativePath
                },
                message:
                    "Successfully deleted file which had been deleted remotely",
                author: response.userId,
                timestamp: new Date(response.updatedDate)
            });
        }
    });
}

/**
 * Compute diff and send text or binary update to server.
 */
async function executeSyncUpdateSendChanges(
    deps: SyncDeps,
    doc: TrackedDocument,
    contentBytes: Uint8Array
): Promise<DocumentUpdateResponse> {
    const isText =
        !isBinary(contentBytes) &&
        isFileTypeMergable(
            doc.relativePath,
            (await deps.serverConfig.getConfig()).mergeableFileExtensions
        );
    const cachedVersion = deps.contentCache.get(doc.serverVersion);

    // Try text diff first; if it fails (e.g., binary content classified
    // as text because it's ASCII), fall back to binary update.
    let computedDiff: (number | string)[] | undefined;
    if (isText && cachedVersion !== undefined) {
        try {
            computedDiff = diff(
                decodeText(cachedVersion) ?? "",
                decodeText(contentBytes) ?? "",
                "Markdown"
            );
        } catch {
            deps.logger.info(
                `Diff computation failed for ${doc.relativePath}, falling back to binary update`
            );
        }
    }

    if (computedDiff !== undefined) {
        try {
            return await deps.syncService.putText({
                documentId: doc.documentId,
                parentVersionId: doc.serverVersion,
                relativePath: doc.relativePath,
                content: computedDiff
            });
        } catch (e) {
            if (e instanceof HttpClientError) {
                deps.logger.info(
                    `putText failed with ${e.status} for ${doc.relativePath}, falling back to putBinary`
                );
                return deps.syncService.putBinary({
                    documentId: doc.documentId,
                    parentVersionId: doc.serverVersion,
                    relativePath: doc.relativePath,
                    contentBytes
                });
            } else {
                throw e;
            }
        }
    } else {
        return deps.syncService.putBinary({
            documentId: doc.documentId,
            parentVersionId: doc.serverVersion,
            relativePath: doc.relativePath,
            contentBytes
        });
    }
}

/**
 * Inner update path used after a create detects in-flight edits, or by
 * callers that already have the file content and hash.
 */
async function executeSyncUpdateInner(
    deps: SyncDeps,
    doc: TrackedDocument,
    contentBytes: Uint8Array,
    contentHash: string,
    originalRelativePath: string,
    oldPath: string | undefined,
    force: boolean
): Promise<void> {
    const areThereLocalChanges =
        doc.localHash !== contentHash ||
        oldPath !== undefined;

    let response: DocumentVersion | DocumentUpdateResponse;

    if (areThereLocalChanges) {
        response = await executeSyncUpdateSendChanges(
            deps,
            doc,
            contentBytes
        );
    } else if (force) {
        const fullResponse = await deps.syncService.get({
            documentId: doc.documentId
        });
        const serverBytes = base64ToBytes(fullResponse.contentBase64);
        if (hash(serverBytes) === contentHash) {
            deps.vfs.updateTracked(
                fullResponse.documentId,
                fullResponse.vaultUpdateId,
                contentHash,
                fullResponse.relativePath
            );
            await updateCache(
                deps.contentCache,
                deps.serverConfig,
                fullResponse.vaultUpdateId,
                serverBytes,
                doc.relativePath
            );
            deps.vfs.addSeenUpdateId(fullResponse.vaultUpdateId);
            return;
        }
        response = fullResponse;
    } else {
        return;
    }

    await applyServerResponse(
        deps,
        doc,
        response,
        contentHash,
        originalRelativePath,
        contentBytes
    );
}

// ---------------------------------------------------------------------------
// 3. executeSyncDelete
// ---------------------------------------------------------------------------

export async function executeSyncDelete(
    deps: SyncDeps,
    doc: DeletedLocallyDocument
): Promise<void> {
    const updateDetails: SyncDeleteDetails = {
        type: SyncType.DELETE,
        relativePath: doc.relativePath
    };

    await executeSync(deps, updateDetails, async () => {
        const response = await deps.syncService.delete({
            documentId: doc.documentId,
            relativePath: doc.relativePath
        });

        deps.vfs.confirmDelete(doc.documentId);

        deps.vfs.addSeenUpdateId(response.vaultUpdateId);

        deps.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: updateDetails,
            message: `Successfully deleted locally deleted file on the server`,
            author: response.userId
        });
    });
}

// ---------------------------------------------------------------------------
// 4. executeRemoteUpdate
// ---------------------------------------------------------------------------

export async function executeRemoteUpdate(
    deps: SyncDeps,
    remoteVersion: DocumentVersionWithoutContent,
    doc?: VirtualDocument
): Promise<void> {
    const updateDetails: SyncCreateDetails = {
        type: SyncType.CREATE,
        relativePath: remoteVersion.relativePath
    };

    await executeSync(deps, updateDetails, async () => {
        // If the document has been marked as deleted locally, check
        // whether the server-side delete was actually sent.
        if (doc?.state === "deleted-locally") {
            if (!remoteVersion.isDeleted) {
                deps.logger.debug(
                    `Document ${doc.relativePath} is deleted locally but alive remotely, sending delete to server`
                );
                await executeSyncDelete(deps, doc);
            } else {
                deps.logger.debug(
                    `Document ${doc.relativePath} is marked as deleted locally, skipping remote update`
                );
            }
            return;
        }

        if (doc?.state === "tracked") {
            // If the file exists locally, let's pretend the user has updated it
            // and deal with remote update/deletion within the update path
            if (doc.serverVersion >= remoteVersion.vaultUpdateId) {
                deps.logger.debug(
                    `Document ${doc.relativePath} is already at least as up-to-date as the fetched version`
                );
                return;
            }

            return executeSyncUpdateFull(deps, doc, undefined, true);
        } else if (remoteVersion.isDeleted) {
            deps.logger.debug(
                `Document ${remoteVersion.relativePath} has been deleted remotely, no need to sync`
            );
            deps.vfs.addSeenUpdateId(remoteVersion.vaultUpdateId);
            return;
        }

        // Don't download oversized files
        const historyEntryForSkippedOversizedFile =
            getHistoryEntryForSkippedOversizedFile(
                remoteVersion.contentSize,
                remoteVersion.relativePath,
                deps.settings
            );
        if (historyEntryForSkippedOversizedFile !== undefined) {
            deps.history.addHistoryEntry(
                historyEntryForSkippedOversizedFile
            );
            return;
        }

        const contentBytes =
            await deps.syncService.getDocumentVersionContent({
                documentId: remoteVersion.documentId,
                vaultUpdateId: remoteVersion.vaultUpdateId
            });

        // We're trying to create an entirely new document that didn't exist locally.
        // Re-check after the download in case a concurrent operation created it.
        const existingByDocId = deps.vfs.getByDocumentId(
            remoteVersion.documentId
        );
        if (existingByDocId !== undefined) {
            deps.logger.debug(
                `Document ${remoteVersion.relativePath} has already been created locally, no need to create it again`
            );
            return;
        }

        // If a pending local create exists at the same path AND the file
        // extension is mergeable (text), skip the download.
        const pendingAtSamePath = deps.vfs.pendingDocuments().find(
            (d) =>
                d.relativePath === remoteVersion.relativePath ||
                d.originalCreationPath === remoteVersion.relativePath
        );
        const mergeableExtensions = (
            await deps.serverConfig.getConfig()
        ).mergeableFileExtensions;
        const isMergeablePath = isFileTypeMergable(
            remoteVersion.relativePath,
            mergeableExtensions
        );
        if (pendingAtSamePath !== undefined && isMergeablePath) {
            deps.logger.info(
                `Pending local create exists at ${pendingAtSamePath.relativePath} ` +
                    `for mergeable path ${remoteVersion.relativePath}, ` +
                    `skipping remote create — idempotency key resolution will handle it`
            );
            return;
        }

        // Before displacing an existing file via ensureClearPath, check
        // if it already has the correct content.
        const contentHashForDownload = hash(contentBytes);
        let fileAlreadyCorrect = false;
        if (await deps.operations.exists(remoteVersion.relativePath)) {
            try {
                const existingBytes = await deps.operations.read(
                    remoteVersion.relativePath
                );
                if (hash(existingBytes) === contentHashForDownload) {
                    fileAlreadyCorrect = true;
                    deps.logger.debug(
                        `File at ${remoteVersion.relativePath} already has correct content, skipping displacement`
                    );
                }
            } catch {
                // File read failed, proceed with normal displacement
            }
        }

        if (!fileAlreadyCorrect) {
            await deps.operations.ensureClearPath(
                remoteVersion.relativePath
            );
        }

        const pendingDocument = await deps.vfs.createPending(
            remoteVersion.relativePath
        );

        if (!fileAlreadyCorrect) {
            await deps.operations.create(
                remoteVersion.relativePath,
                contentBytes
            );
        }

        const stale = deps.vfs.ensureUniqueDocumentId(
            remoteVersion.documentId,
            pendingDocument
        );
        if (stale !== undefined) {
            deps.logger.info(
                `Removed stale document at ${stale.relativePath} ` +
                    `with documentId ${remoteVersion.documentId} ` +
                    `(superseded by remote download at ${remoteVersion.relativePath})`
            );
        }

        deps.vfs.confirmCreate(
            pendingDocument.idempotencyKey,
            remoteVersion.documentId,
            remoteVersion.vaultUpdateId,
            hash(contentBytes),
            remoteVersion.relativePath
        );

        deps.vfs.addSeenUpdateId(remoteVersion.vaultUpdateId);

        await updateCache(
            deps.contentCache,
            deps.serverConfig,
            remoteVersion.vaultUpdateId,
            contentBytes,
            remoteVersion.relativePath
        );

        deps.history.addHistoryEntry({
            status: SyncStatus.SUCCESS,
            details: updateDetails,
            message: `Successfully downloaded remote file which hadn't existed locally`,
            author: remoteVersion.userId,
            timestamp: new Date(remoteVersion.updatedDate)
        });
    });
}
