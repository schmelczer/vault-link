import type {
    Database,
    DocumentRecord,
    RelativePath
} from "../persistence/database";
import { diff } from "reconcile-text";
import type { SyncService } from "../services/sync-service";
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
import { EMPTY_HASH, hash } from "../utils/hash";
import { base64ToBytes } from "byte-base64";
import type { Settings } from "../persistence/settings";
import type { FileOperations } from "../file-operations/file-operations";
import { FileNotFoundError } from "../errors/file-not-found-error";
import { SyncResetError } from "../errors/sync-reset-error";
import { globsToRegexes } from "../utils/globs-to-regexes";
import type { DocumentVersion } from "../services/types/DocumentVersion";
import type { DocumentUpdateResponse } from "../services/types/DocumentUpdateResponse";
import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";
import type { FixedSizeDocumentCache } from "../utils/data-structures/fix-sized-cache";
import { isFileTypeMergable } from "../utils/is-file-type-mergable";
import { isBinary } from "../utils/is-binary";
import type { ServerConfig } from "../services/server-config";

export class UnrestrictedSyncer {
    private ignorePatterns: RegExp[];

    public constructor(
        private readonly logger: Logger,
        private readonly database: Database,
        private readonly settings: Settings,
        private readonly syncService: SyncService,
        private readonly operations: FileOperations,
        private readonly history: SyncHistory,
        private readonly contentCache: FixedSizeDocumentCache,
        private readonly serverConfig: ServerConfig
    ) {
        this.ignorePatterns = globsToRegexes(
            this.settings.getSettings().ignorePatterns,
            this.logger
        );

        this.settings.onSettingsChanged.add((newSettings) => {
            this.ignorePatterns = globsToRegexes(
                newSettings.ignorePatterns,
                this.logger
            );
        });
    }

    public async resolveIdempotencyKeys(): Promise<void> {
        const pendingDocs = this.database.pendingDocuments;
        if (pendingDocs.length === 0) {
            return;
        }

        const keys = pendingDocs
            .map((d) => d.idempotencyKey)
            // eslint-disable-next-line no-restricted-syntax -- Type narrowing, not removing a specific item
            .filter((k): k is string => k !== undefined);
        if (keys.length === 0) {
            return;
        }

        this.logger.debug(
            `Resolving ${keys.length} pending idempotency keys`
        );

        const resolved =
            await this.syncService.resolveIdempotencyKeys(keys);

        for (const doc of pendingDocs) {
            if (
                doc.idempotencyKey !== undefined &&
                resolved.has(doc.idempotencyKey)
            ) {
                const documentId = resolved.get(doc.idempotencyKey)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion

                // Skip if this documentId is already assigned to another document
                const existing =
                    this.database.getDocumentByDocumentId(documentId);
                if (existing !== undefined) {
                    this.logger.debug(
                        `Document ${documentId} already exists at ${existing.relativePath}, removing stale pending doc at ${doc.relativePath}`
                    );
                    this.database.removeDocument(doc);
                    continue;
                }

                this.logger.info(
                    `Resolved idempotency key ${doc.idempotencyKey} to document ${documentId} for ${doc.relativePath}`
                );
                this.database.updateDocumentMetadata(
                    {
                        documentId,
                        parentVersionId: 0,
                        hash: "",
                        remoteRelativePath: doc.relativePath
                    },
                    doc
                );
            }
        }
    }

    public async unrestrictedSyncLocallyCreatedOrUpdatedFile({
        oldPath,
        // We use the same code path for both local and remote updates. We need to force the update
        // if there are no local changes but we know that the remote version is newer.
        force = false,
        document
    }: {
        oldPath?: RelativePath;
        force?: boolean;
        document: DocumentRecord;
    }): Promise<void> {
        const updateDetails:
            | SyncCreateDetails
            | SyncUpdateDetails
            | SyncMovedDetails =
            document.metadata === undefined
                ? {
                    type: SyncType.CREATE,
                    relativePath: document.relativePath
                }
                : oldPath !== undefined
                    ? {
                        type: SyncType.MOVE,
                        relativePath: document.relativePath,
                        movedFrom: oldPath
                    }
                    : {
                        type: SyncType.UPDATE,
                        relativePath: document.relativePath
                    };

        await this.executeSync(updateDetails, async () => {
            const originalRelativePath = document.relativePath;

            if (document.isDeleted) {
                this.logger.debug(
                    `Document ${document.relativePath} has been already deleted, no need to update it`
                );
                return;
            }

            const contentBytes = await this.operations.read(
                document.relativePath
            ); // this can throw FileNotFoundError
            const contentHash = hash(contentBytes);

            let response: DocumentVersion | DocumentUpdateResponse | undefined =
                undefined;
            if (document.metadata === undefined) {
                response = await this.syncService.create({
                    relativePath: originalRelativePath,
                    contentBytes,
                    idempotencyKey: document.idempotencyKey
                });

                await this.handleMaybeMergingResponse({
                    document,
                    response,
                    contentHash,
                    originalRelativePath,
                    originalContentBytes: contentBytes,
                    isCreate: true
                });
            } else {
                const areThereLocalChanges =
                    document.metadata.hash !== contentHash ||
                    oldPath !== undefined;

                if (areThereLocalChanges) {
                    const isText =
                        !isBinary(contentBytes) &&
                        isFileTypeMergable(
                            document.relativePath,
                            (await this.serverConfig.getConfig())
                                .mergeableFileExtensions
                        );
                    const cachedVersion = this.contentCache.get(
                        document.metadata.parentVersionId
                    );

                    response =
                        isText && cachedVersion !== undefined
                            ? await this.syncService.putText({
                                documentId: document.metadata.documentId,
                                parentVersionId:
                                    document.metadata.parentVersionId,
                                relativePath: document.relativePath,
                                content: diff(
                                    new TextDecoder().decode(cachedVersion),
                                    new TextDecoder().decode(contentBytes)
                                )
                            })
                            : await this.syncService.putBinary({
                                documentId: document.metadata.documentId,
                                parentVersionId:
                                    document.metadata.parentVersionId,
                                relativePath: document.relativePath,
                                contentBytes
                            });
                } else {
                    if (!force) {
                        this.logger.debug(
                            `File hash of ${document.relativePath} matches with last synced version and the path hasn't changed; no need to sync`
                        );
                        return;
                    }

                    // we use this code path (force == true) to sync remotely updated files which have no local changes
                    response = await this.syncService.get({
                        documentId: document.metadata.documentId
                    });
                }

                await this.handleMaybeMergingResponse({
                    document,
                    response,
                    contentHash,
                    originalRelativePath,
                    originalContentBytes: contentBytes
                });
            }

            if (!("type" in response) || response.type === "MergingUpdate") {
                if (!force) {
                    this.history.addHistoryEntry({
                        status: SyncStatus.SUCCESS,
                        details: updateDetails,
                        message: `The file we updated had been updated remotely, so we downloaded the merged version`
                    });
                    return;
                }
            }

            const actualUpdateDetails: SyncUpdateDetails | SyncMovedDetails =
                oldPath !== undefined ||
                    response.relativePath != originalRelativePath
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
                this.history.addHistoryEntry({
                    status: SyncStatus.SUCCESS,
                    details: actualUpdateDetails,
                    message: `Successfully downloaded remotely updated file from the server`,
                    author: response.userId,
                    timestamp: new Date(response.updatedDate)
                });
            } else {
                this.history.addHistoryEntry({
                    status: SyncStatus.SUCCESS,
                    details: {
                        type: SyncType.DELETE,
                        relativePath: document.relativePath
                    },
                    message:
                        "Successfully deleted file which had been deleted remotely",
                    author: response.userId,
                    timestamp: new Date(response.updatedDate)
                });
            }
        });
    }

    public async unrestrictedSyncLocallyDeletedFile(
        document: DocumentRecord
    ): Promise<void> {
        const updateDetails: SyncDeleteDetails = {
            type: SyncType.DELETE,
            relativePath: document.relativePath
        };

        await this.executeSync(updateDetails, async () => {
            if (document.metadata === undefined) {
                this.logger.debug(
                    `Document ${document.relativePath} has never been synced, no need to delete it remotely`
                );
                return;
            }

            const response = await this.syncService.delete({
                documentId: document.metadata.documentId,
                relativePath: document.relativePath
            });

            // A concurrent merge operation may have removed this document from the
            // database while we were waiting for the delete response. In that case,
            // the merge already handled the state transition and we should not
            // update metadata (which would fail anyway since the document is gone).
            if (!this.database.containsDocument(document)) {
                this.logger.debug(
                    `Document ${document.relativePath} was removed from database by a concurrent operation, skipping metadata update after delete`
                );
                this.database.addSeenUpdateId(response.vaultUpdateId);
                return;
            }

            this.database.updateDocumentMetadata(
                {
                    documentId: response.documentId,
                    parentVersionId: response.vaultUpdateId,
                    hash: EMPTY_HASH,
                    remoteRelativePath: document.relativePath
                },
                document
            );

            this.database.addSeenUpdateId(response.vaultUpdateId);

            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: updateDetails,
                message: `Successfully deleted locally deleted file on the server`,
                author: response.userId
            });
        });
    }

    public async unrestrictedSyncRemotelyUpdatedFile(
        remoteVersion: DocumentVersionWithoutContent,
        document?: DocumentRecord
    ): Promise<void> {
        const updateDetails: SyncCreateDetails = {
            type: SyncType.CREATE,
            relativePath: remoteVersion.relativePath
        };

        await this.executeSync(updateDetails, async () => {
            if (document?.metadata !== undefined) {
                // If the file exists locally, let's pretend the user has updated it
                // and deal with remote update/deletion within `unrestrictedSyncLocallyUpdatedFile`
                if (
                    document.metadata.parentVersionId >=
                    remoteVersion.vaultUpdateId
                ) {
                    this.logger.debug(
                        `Document ${document.relativePath} is already at least as up-to-date as the fetched version`
                    );

                    return;
                }

                return this.unrestrictedSyncLocallyCreatedOrUpdatedFile({
                    document,
                    force: true
                });
            } else if (remoteVersion.isDeleted) {
                // Either the document hasn't made it to us before and therefore we don't need to delete it,
                // or we already have it, in which case the preceeding if would've dealt with it
                this.logger.debug(
                    `Document ${remoteVersion.relativePath} has been deleted remotely, no need to sync`
                );
                return;
            }

            // Don't download oversized files
            const historyEntryForSkippedOversizedFile =
                this.getHistoryEntryForSkippedOversizedFile(
                    remoteVersion.contentSize,
                    remoteVersion.relativePath
                );
            if (historyEntryForSkippedOversizedFile !== undefined) {
                this.history.addHistoryEntry(
                    historyEntryForSkippedOversizedFile
                );
                return;
            }

            const contentBytes =
                await this.syncService.getDocumentVersionContent({
                    documentId: remoteVersion.documentId,
                    vaultUpdateId: remoteVersion.vaultUpdateId
                });

            // We're trying to create an entirely new document that didn't exist locally
            document = this.database.getDocumentByDocumentId(
                remoteVersion.documentId
            );
            // It can happen that a concurrent sync operation has already created the document, so we can bail here
            if (document !== undefined) {
                this.logger.debug(
                    `Document ${remoteVersion.relativePath} has already been created locally, no need to create it again`
                );
                return;
            }

            await this.operations.ensureClearPath(remoteVersion.relativePath);

            this.database.updateDocumentMetadata(
                {
                    documentId: remoteVersion.documentId,
                    parentVersionId: remoteVersion.vaultUpdateId,
                    hash: hash(contentBytes),
                    remoteRelativePath: remoteVersion.relativePath
                },
                this.database.createNewPendingDocument(
                    remoteVersion.relativePath
                )
            );

            await this.operations.create(
                remoteVersion.relativePath,
                contentBytes
            );
            await this.updateCache(
                remoteVersion.vaultUpdateId,
                contentBytes,
                remoteVersion.relativePath
            );

            this.history.addHistoryEntry({
                status: SyncStatus.SUCCESS,
                details: updateDetails,
                message: `Successfully downloaded remote file which hadn't existed locally`,
                author: remoteVersion.userId,
                timestamp: new Date(remoteVersion.updatedDate)
            });
        });
    }

    private async executeSync<T>(
        details: SyncDetails,
        fn: () => Promise<T>
    ): Promise<T | undefined> {
        if (!this.settings.getSettings().isSyncEnabled) {
            this.logger.info(
                `Skipping sync operation for file '${details.relativePath}' because sync is disabled`
            );
            return;
        }

        for (const pattern of this.ignorePatterns) {
            if (pattern.test(details.relativePath)) {
                this.logger.debug(
                    `File '${details.relativePath}' is ignored by the ignore pattern: ${pattern}`
                );
                return; // bail without SKIPPED status because we were told to ignore this file and we shouldn't clutter up the history
            }
        }

        try {
            // Only check the size of files which already exist locally.
            if (await this.operations.exists(details.relativePath)) {
                const sizeInBytes = await this.operations.getFileSize(
                    details.relativePath
                );
                const historyEntryForSkippedOversizedFile =
                    this.getHistoryEntryForSkippedOversizedFile(
                        sizeInBytes,
                        details.relativePath
                    );
                if (historyEntryForSkippedOversizedFile !== undefined) {
                    this.history.addHistoryEntry(
                        historyEntryForSkippedOversizedFile
                    );
                    return;
                }
            }

            return await fn();
        } catch (e) {
            if (e instanceof FileNotFoundError) {
                // A subsequent sync operation must have been creating to deal with this
                this.logger.info(
                    `Skiping file '${details.relativePath}' because it no longer exists when trying to ${details.type.toLocaleLowerCase()} it`
                );
                return;
            }
            if (e instanceof SyncResetError) {
                this.logger.info(
                    `Interrupting sync operation because of a reset`
                );
                return;
            } else {
                this.history.addHistoryEntry({
                    status: SyncStatus.ERROR,
                    details,
                    message: `Failed to sync file '${details.relativePath}' because of ${e} when trying to ${details.type.toLocaleLowerCase()} it`
                });
                throw e;
            }
        }
    }

    private async handleMaybeMergingResponse({
        document,
        response,
        contentHash,
        originalRelativePath,
        originalContentBytes,
        isCreate
    }: {
        document: DocumentRecord;
        response: DocumentVersion | DocumentUpdateResponse;
        contentHash: string;
        originalRelativePath: string;
        originalContentBytes: Uint8Array;
        isCreate?: boolean;
    }): Promise<void> {
        // `document` is mutable and reflects the latest state in the local database
        if (document.isDeleted) {
            this.logger.info(
                `Document ${document.relativePath} has been deleted before we could finish updating it`
            );
            this.database.addSeenUpdateId(response.vaultUpdateId);
            return;
        }

        if (
            (document.metadata?.parentVersionId ?? 0) > response.vaultUpdateId
        ) {
            this.logger.debug(
                `Document ${document.relativePath} is already more up to date than the fetched version`
            );
            this.database.addSeenUpdateId(response.vaultUpdateId); // in case the previous `vaultUpdateId` update hasn't made it through
            return;
        }

        if (response.isDeleted) {
            return this.applyRemoteDeleteLocally(document, response);
        }

        let actualPath = document.relativePath;

        let existingContentBytes: Uint8Array | undefined;

        if (isCreate) {
            // We have a file locally that got moved by another client to the same path as the one we're trying to create.
            // The server returns a merging update for the document ID that already exists locally (but at another path).
            // We have to merge these two documents by extending the provenance of the existing document and deleting
            // the old document that the new document already contains the content for.
            const existingDocument = this.database.getDocumentByDocumentId(
                response.documentId
            );
            // If existingDocument === document, then a previous sync operation already
            // assigned this documentId to our document. We don't need to merge - just
            // continue to update the metadata below.
            if (existingDocument !== undefined && existingDocument !== document) {
                this.logger.info(
                    `Merging existing document ${existingDocument.relativePath} into ${document.relativePath
                    } after concurrent move & creation`
                );
                if (!existingDocument.isDeleted) {
                    this.database.delete(existingDocument.relativePath); // make sure syncLocallyDeletedFile doesn't actually schedule deleting the new file

                    try {
                        existingContentBytes = await this.operations.read(
                            existingDocument.relativePath
                        );
                    } catch (e) {
                        if (e instanceof FileNotFoundError) {
                            return;
                        }
                        throw e;
                    }

                    this.database.removeDocument(existingDocument);
                    await this.operations.delete(existingDocument.relativePath);

                } else {
                    this.database.removeDocument(existingDocument);
                }
            }
        }

        // A document's documentId should never change once assigned. If the response has a
        // different documentId than what the document already has, it means the file was
        // renamed during the sync operation and the response is for a different document.
        // We should bail out and let subsequent sync operations fix the state.
        if (
            document.metadata?.documentId !== undefined &&
            document.metadata.documentId !== response.documentId
        ) {
            this.logger.info(
                `Document ${document.relativePath} already has documentId ${document.metadata.documentId}, ` +
                    `but response has documentId ${response.documentId}. Ignoring response to prevent documentId corruption.`
            );
            this.database.addSeenUpdateId(response.vaultUpdateId);
            return;
        }

        // this can't happen on the creation path as we can only get a merging response if a document already exists remotely on the same path
        if (response.relativePath != originalRelativePath) {
            actualPath = response.relativePath;
            // Make sure to update the remote relative path to avoid uploading
            // the file as a result of this filesystem event.
            if (document.metadata !== undefined) {
                document.metadata.remoteRelativePath = response.relativePath;
            }
            await this.operations.move(
                document.relativePath,
                response.relativePath
            ); // this can throw FileNotFoundError
        }

        if (!("type" in response) || response.type === "MergingUpdate") {
            const responseBytes = base64ToBytes(response.contentBase64);
            contentHash = hash(responseBytes);

            this.database.updateDocumentMetadata(
                {
                    documentId: response.documentId,
                    parentVersionId: response.vaultUpdateId,
                    hash: contentHash,
                    remoteRelativePath: response.relativePath
                },
                document
            );

            await this.operations.write(
                actualPath,
                originalContentBytes,
                responseBytes
            );

            if (existingContentBytes !== undefined) {
                // the merge case is only always for text files, so don't mind that we have to provide a byte array here
                await this.operations.write(
                    actualPath,
                    new Uint8Array(0),
                    existingContentBytes
                );
            }


            await this.updateCache(
                response.vaultUpdateId,
                responseBytes,
                actualPath
            );
        } else {
            this.database.updateDocumentMetadata(
                {
                    documentId: response.documentId,
                    parentVersionId: response.vaultUpdateId,
                    hash: contentHash,
                    remoteRelativePath: response.relativePath
                },
                document
            );
            await this.updateCache(
                response.vaultUpdateId,
                originalContentBytes,
                actualPath
            );
        }

        this.database.addSeenUpdateId(response.vaultUpdateId);
    }

    private getHistoryEntryForSkippedOversizedFile(
        sizeInBytes: number,
        relativePath: RelativePath
    ): CommonHistoryEntry | undefined {
        const sizeInMB = Math.round(sizeInBytes / 1024 / 1024);
        const { maxFileSizeMB } = this.settings.getSettings();
        if (sizeInMB > maxFileSizeMB) {
            return {
                status: SyncStatus.SKIPPED,
                details: {
                    type: SyncType.SKIPPED,
                    relativePath
                },
                message: `File size of ${sizeInMB} MB exceeds the maximum file size limit of ${maxFileSizeMB
                    } MB`
            };
        }
    }

    private async updateCache(
        updateId: number,
        contentBytes: Uint8Array,
        filePath: RelativePath
    ): Promise<void> {
        if (
            isFileTypeMergable(
                filePath,
                (await this.serverConfig.getConfig()).mergeableFileExtensions
            ) &&
            !isBinary(contentBytes)
        ) {
            this.contentCache.put(updateId, contentBytes);
        }
    }

    private async applyRemoteDeleteLocally(
        document: DocumentRecord,
        response: DocumentVersion | DocumentUpdateResponse
    ): Promise<void> {
        this.database.delete(document.relativePath);
        this.database.updateDocumentMetadata(
            {
                documentId: response.documentId,
                parentVersionId: response.vaultUpdateId,
                hash: EMPTY_HASH,
                remoteRelativePath: response.relativePath
            },
            document
        );

        await this.operations.delete(document.relativePath);

        this.database.addSeenUpdateId(response.vaultUpdateId);
    }
}
