import type {
	Database,
	DocumentId,
	DocumentRecord,
	RelativePath
} from "../persistence/database";

import type { SyncService } from "src/services/sync-service";
import { Logger } from "src/tracing/logger";
import type { SyncHistory } from "src/tracing/sync-history";
import { SyncSource, SyncStatus, SyncType } from "src/tracing/sync-history";
import { EMPTY_HASH, hash } from "src/utils/hash";
import type { components } from "src/services/types";
import { deserialize } from "src/utils/deserialize";
import type { Settings } from "src/persistence/settings";
import type { FileOperations } from "src/file-operations/file-operations";
import { FileNotFoundError } from "src/file-operations/safe-filesystem-operations";
import { DocumentLocks } from "../file-operations/document-locks";
import { createPromise } from "src/utils/create-promise";

export class UnrestrictedSyncer {
	private readonly locks: DocumentLocks;

	public constructor(
		private readonly logger: Logger,
		private readonly database: Database,
		private readonly settings: Settings,
		private readonly syncService: SyncService,
		private readonly operations: FileOperations,
		private readonly history: SyncHistory
	) {
		this.locks = new DocumentLocks(logger);
	}

	public async unrestrictedSyncLocallyCreatedFile(
		proposedDocumentId: DocumentId,
		getLatestDocument: () => DocumentRecord
	): Promise<void> {
		let latestDocument = getLatestDocument();

		return this.executeSync(
			[latestDocument.relativePath],
			SyncType.CREATE,
			SyncSource.PUSH,
			async () => {
				const contentBytes = await this.operations.read(
					latestDocument.relativePath
				); // this can throw FileNotFoundError
				const contentHash = hash(contentBytes);

				const response = await this.syncService.create({
					documentId: proposedDocumentId,
					relativePath: latestDocument.relativePath,
					contentBytes
				});

				latestDocument = getLatestDocument();

				this.history.addHistoryEntry({
					status: SyncStatus.SUCCESS,
					source: SyncSource.PUSH,
					relativePath: latestDocument.relativePath,
					message: `Successfully uploaded locally created file`,
					type: SyncType.CREATE
				});

				this.database.setDocument(
					{
						relativePath: latestDocument.relativePath,
						documentId: response.documentId,
						parentVersionId: response.vaultUpdateId,
						hash: contentHash
					},
					latestDocument.identity
				);

				this.tryIncrementVaultUpdateId(response.vaultUpdateId);
			}
		);
	}

	public async unrestrictedSyncLocallyDeletedFile(
		getLatestDocument: () => DocumentRecord
	): Promise<void> {
		let document = getLatestDocument();
		await this.executeSync(
			[document.relativePath],
			SyncType.DELETE,
			SyncSource.PUSH,
			async () => {
				const response = await this.syncService.delete({
					documentId: document.documentId,
					relativePath: document.relativePath
				});

				this.history.addHistoryEntry({
					status: SyncStatus.SUCCESS,
					source: SyncSource.PUSH,
					relativePath: document.relativePath,
					message: `Successfully deleted locally deleted file on the remote server`,
					type: SyncType.DELETE
				});

				document = getLatestDocument();

				this.database.setDocument(
					{
						relativePath: document.relativePath,
						documentId: response.documentId,
						parentVersionId: response.vaultUpdateId,
						hash: EMPTY_HASH
					},
					document.identity
				);
			}
		);
	}

	public async unrestrictedSyncLocallyUpdatedFile({
		oldPath,
		getLatestDocument
	}: {
		oldPath?: RelativePath;
		getLatestDocument: () => DocumentRecord;
	}): Promise<void> {
		let document = getLatestDocument();

		await this.executeSync(
			[oldPath, document.relativePath].filter(
				(path) => path !== undefined
			),
			SyncType.UPDATE,
			SyncSource.PUSH,
			async () => {
				if (document.metadata === undefined || document.isDeleted) {
					this.logger.debug(
						`Document ${document.relativePath} has been already deleted, no need to update it`
					);
					return;
				}

				const contentBytes = await this.operations.read(
					document.relativePath
				); // this can throw FileNotFoundError
				let contentHash = hash(contentBytes);

				if (
					document.metadata.hash === contentHash &&
					oldPath === undefined
				) {
					this.logger.debug(
						`File hash of ${document.relativePath} matches with last synced version and the path hasn't changed; no need to sync`
					);
					return;
				}

				const response = await this.syncService.put({
					documentId: document.documentId,
					parentVersionId: document.metadata.parentVersionId,
					relativePath: document.relativePath,
					contentBytes
				});

				document = getLatestDocument();

				if (document.isDeleted) {
					this.logger.info(
						`Document ${document.relativePath} has been deleted before we could finish updating it`
					);
					return;
				}

				if (!document.metadata) {
					throw new Error(
						`Document ${document.relativePath} no longer has metadata after updating it`
					);
				}

				if (
					document.metadata.parentVersionId >= response.vaultUpdateId
				) {
					this.logger.debug(
						`Document ${document.relativePath} is already more up to date than the fetched version`
					);
					return;
				}

				this.history.addHistoryEntry({
					status: SyncStatus.SUCCESS,
					source: SyncSource.PUSH,
					relativePath: document.relativePath,
					message: `Successfully uploaded locally updated file to the remote server`,
					type: SyncType.UPDATE
				});

				if (response.isDeleted) {
					await this.operations.delete(document.relativePath);

					this.history.addHistoryEntry({
						status: SyncStatus.SUCCESS,
						source: SyncSource.PULL,
						relativePath: document.relativePath,
						message:
							"The file we tried to update had been deleted remotely, therefore, we have deleted it locally",
						type: SyncType.DELETE
					});

					this.database.delete(document.relativePath);
					this.database.setDocument(
						{
							documentId: response.documentId,
							relativePath: document.relativePath,
							parentVersionId: response.vaultUpdateId,
							hash: EMPTY_HASH
						},
						document.identity
					);

					this.tryIncrementVaultUpdateId(response.vaultUpdateId);

					return;
				}

				if (response.relativePath != document.relativePath) {
					// this.database.getNewResolvedDocumentByRelativePath(
					// 	response.relativePath,
					// 	promise
					// );

					await this.operations.move(
						document.relativePath,
						response.relativePath,
						response.documentId
					); // this can throw FileNotFoundError
				}

				if (response.type === "MergingUpdate") {
					const responseBytes = deserialize(response.contentBase64);
					contentHash = hash(responseBytes);

					await this.operations.write(
						response.relativePath,
						contentBytes,
						responseBytes
					);

					this.history.addHistoryEntry({
						status: SyncStatus.SUCCESS,
						source: SyncSource.PULL,
						relativePath: document.relativePath,
						message: `The file we updated had been updated remotely, so we downloaded the merged version`,
						type: SyncType.UPDATE
					});
				}

				document = getLatestDocument();

				this.database.setDocument(
					{
						documentId: response.documentId,
						relativePath: document.relativePath,
						parentVersionId: response.vaultUpdateId,
						hash: contentHash
					},
					document.identity
				);

				this.tryIncrementVaultUpdateId(response.vaultUpdateId);
			}
		);
	}

	public async unrestrictedSyncRemotelyUpdatedFile(
		remoteVersion: components["schemas"]["DocumentVersionWithoutContent"],
		getLatestDocument: () => DocumentRecord | undefined
	): Promise<void> {
		await this.executeSync(
			[remoteVersion.relativePath],
			SyncType.UPDATE,
			SyncSource.PULL,
			async () => {
				let localMetadata = getLatestDocument();

				if (
					localMetadata !== undefined &&
					localMetadata?.metadata !== undefined
				) {
					// If the file exists locally, let's pretend the user has updated it
					// and deal with remote update/deletion within `unrestrictedSyncLocallyUpdatedFile`
					if (
						localMetadata.metadata.parentVersionId >=
						remoteVersion.vaultUpdateId
					) {
						this.logger.debug(
							`Document ${remoteVersion.relativePath} is already more up to date than the fetched version`
						);
						return;
					}

					return this.unrestrictedSyncLocallyUpdatedFile({
						getLatestDocument: () =>
							this.database.getDocumentByIdentity(
								localMetadata!.identity
							)
					});
				} else if (remoteVersion.isDeleted) {
					// Either the doc hasn't made it to us before and therefore we don't need to delete it,
					// or we already have it, in which case the preceeding if will deal with it
					this.logger.debug(
						`Document ${remoteVersion.relativePath} has been deleted remotely, no need to sync`
					);
					return;
				}

				const content = (
					await this.syncService.get({
						documentId: remoteVersion.documentId
					})
				).contentBase64;

				localMetadata = getLatestDocument();

				if (localMetadata?.isDeleted === true) {
					this.logger.info(
						`Document ${remoteVersion.relativePath} has been deleted locally before we could finish updating it`
					);
					return;
				}
				if (
					localMetadata?.metadata?.parentVersionId ??
					-1 >= remoteVersion.vaultUpdateId
				) {
					this.logger.debug(
						`Document ${remoteVersion.relativePath} is already more up to date than the fetched version`
					);
					return;
				}

				const contentBytes = deserialize(content);

				this.database.setDocument(
					{
						documentId: remoteVersion.documentId,
						relativePath: remoteVersion.relativePath,
						parentVersionId: remoteVersion.vaultUpdateId,
						hash: hash(contentBytes)
					},
					localMetadata?.identity
				);

				await this.operations.create(
					remoteVersion.relativePath,
					contentBytes,
					remoteVersion.documentId
				);

				this.history.addHistoryEntry({
					status: SyncStatus.SUCCESS,
					source: SyncSource.PULL,
					relativePath: remoteVersion.relativePath,
					message: `Successfully downloaded remote file which hadn't existed locally`,
					type: SyncType.CREATE
				});
			}
		);
	}

	public async executeSync<T>(
		paths: RelativePath[],
		syncType: SyncType,
		syncSource: SyncSource,
		fn: () => Promise<T>
	): Promise<T | undefined> {
		const relativePath = paths[paths.length - 1];

		if (!this.operations.isFileEligibleForSync(relativePath)) {
			this.history.addHistoryEntry({
				status: SyncStatus.ERROR,
				relativePath,
				message: `File ${relativePath} is not eligible for syncing`,
				type: syncType
			});
			return;
		}

		this.logger.debug(
			`Syncing ${relativePath} (${syncSource} - ${syncType})`
		);

		try {
			if (
				(await this.operations.exists(relativePath)) &&
				(await this.operations.getFileSize(relativePath)) / // this can throw FileNotFoundError
					1024 /
					1024 >
					this.settings.getSettings().maxFileSizeMB
			) {
				this.history.addHistoryEntry({
					status: SyncStatus.ERROR,
					relativePath,
					message: `File size exceeds the maximum file size limit of ${
						this.settings.getSettings().maxFileSizeMB
					}MB`,
					type: syncType
				});
				return;
			}

			return await fn();
		} catch (e) {
			if (e instanceof FileNotFoundError) {
				// A subsequent sync operation must have been creating to deal with this
				this.logger.info(
					`Skip ${syncSource.toLocaleLowerCase()} file because it no longer exists when trying to ${syncType.toLocaleLowerCase()} it`
				);
			} else {
				this.history.addHistoryEntry({
					status: SyncStatus.ERROR,
					relativePath,
					message: `Failed to ${syncSource.toLocaleLowerCase()} file because of ${e} when trying to ${syncType.toLocaleLowerCase()} it`,
					type: syncType,
					source: syncSource
				});
				throw e;
			}
		}
	}

	public reset(): void {
		this.locks.reset();
	}

	private tryIncrementVaultUpdateId(responseVaultUpdateId: number): void {
		if (this.database.getLastSeenUpdateId() === responseVaultUpdateId - 1) {
			this.database.setLastSeenUpdateId(responseVaultUpdateId);
		}
	}
}
