import type {
	Database,
	DocumentMetadata,
	RelativePath
} from "../persistence/database";

import type { SyncService } from "src/services/sync-service";
import type { Logger } from "src/tracing/logger";
import type { SyncHistory } from "src/tracing/sync-history";
import { SyncSource, SyncStatus, SyncType } from "src/tracing/sync-history";
import { EMPTY_HASH, hash } from "src/utils/hash";
import type { components } from "src/services/types";
import { deserialize } from "src/utils/deserialize";
import type { Settings } from "src/persistence/settings";
import type { FileOperations } from "src/file-operations/file-operations";
import { FileNotFoundError } from "src/file-operations/safe-filesystem-operations";
import { DocumentLocks } from "../file-operations/document-locks";

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
		relativePath: RelativePath,
		updateTime: Date,
		optimisations?: {
			contentBytes?: Uint8Array;
			contentHash?: string;
		}
	): Promise<DocumentMetadata | undefined> {
		return this.executeSync(
			[relativePath],
			SyncType.CREATE,
			SyncSource.PUSH,
			async () => {
				const localMetadata = this.database.getDocument(relativePath);

				if (
					!(localMetadata instanceof Promise) &&
					localMetadata &&
					!localMetadata.isDeleted
				) {
					this.logger.debug(
						`Document metadata already exists for ${relativePath}, it must have been downloaded from the server`
					);

					return;
				}

				const contentBytes =
					optimisations?.contentBytes ??
					(await this.operations.read(relativePath)); // this can throw FileNotFoundError
				const contentHash =
					optimisations?.contentHash ?? hash(contentBytes);

				const response = await this.syncService.create({
					relativePath,
					contentBytes,
					createdDate: updateTime
				});

				const currentMetadata =
					this.database.getDocumentByIdentity(localMetadata);
				if (!currentMetadata) {
					throw new Error(
						`Document metadata for ${relativePath} not found after creation`
					);
				}

				this.history.addHistoryEntry({
					status: SyncStatus.SUCCESS,
					source: SyncSource.PUSH,
					relativePath: currentMetadata[0],
					message: `Successfully uploaded locally created file`,
					type: SyncType.CREATE
				});

				const newMetadata = {
					documentId: response.documentId,
					parentVersionId: response.vaultUpdateId,
					hash: contentHash,
					isDeleted: false
				};

				await this.database.setDocument({
					relativePath: currentMetadata[0],
					...newMetadata
				});

				await this.tryIncrementVaultUpdateId(response.vaultUpdateId);

				return newMetadata;
			}
		);
	}

	public async unrestrictedSyncLocallyDeletedFile(
		relativePath: RelativePath,
		metadata: Promise<DocumentMetadata | undefined> | undefined
	): Promise<void> {
		await this.executeSync(
			[relativePath],
			SyncType.DELETE,
			SyncSource.PUSH,
			async () => {
				const localMetadata =
					metadata !== undefined
						? await metadata
						: this.database.getResolvedDocument(relativePath);

				if (!localMetadata || localMetadata.isDeleted) {
					this.logger.info(
						`Locally deleted file hasn't been uploaded yet, so there's no need to delete it on the remote server`
					);

					return;
				}

				const response = await this.syncService.delete({
					documentId: localMetadata.documentId,
					relativePath,
					createdDate: new Date() // We got the event now, so it must have been deleted just now
				});

				this.history.addHistoryEntry({
					status: SyncStatus.SUCCESS,
					source: SyncSource.PUSH,
					relativePath,
					message: `Successfully deleted locally deleted file on the remote server`,
					type: SyncType.DELETE
				});

				const currentMetadata = this.database.getDocumentByDocumentId(
					localMetadata.documentId
				);

				if (!currentMetadata || currentMetadata[1].isDeleted) {
					this.logger.info(
						`No metadata found for deleted file, '${relativePath}' must have been deleted by another operation`
					);

					return;
				}

				await this.operations.delete(currentMetadata[0]);

				// We have to have a record of the delete in case there's an in-flight update for the same
				// document which finishes after the delete has succeeded and would introduce a phantom metadata record.
				await this.database.setDocument({
					relativePath: currentMetadata[0],
					documentId: response.documentId,
					parentVersionId: response.vaultUpdateId,
					hash: EMPTY_HASH,
					isDeleted: true
				});
			}
		);
	}

	public async unrestrictedSyncLocallyUpdatedFile({
		oldPath,
		relativePath,
		metadata,
		updateTime,
		optimisations
	}: {
		oldPath?: RelativePath;
		relativePath: RelativePath;
		metadata: Promise<DocumentMetadata | undefined> | undefined;
		updateTime: Date;
		optimisations?: {
			contentBytes?: Uint8Array;
			contentHash?: string;
		};
	}): Promise<void> {
		await this.executeSync(
			[oldPath, relativePath].filter((path) => path !== undefined),
			SyncType.UPDATE,
			SyncSource.PUSH,
			async () => {
				const localMetadata =
					metadata !== undefined
						? await metadata
						: this.database.getResolvedDocument(relativePath);

				if (!localMetadata || localMetadata.isDeleted) {
					// It's fine, a subsequent sync operation must have dealt with this
					return;
				}

				const contentBytes =
					optimisations?.contentBytes ??
					(await this.operations.read(relativePath)); // this can throw FileNotFoundError

				let contentHash =
					optimisations?.contentHash ?? hash(contentBytes);

				if (
					localMetadata.hash === contentHash &&
					oldPath === undefined
				) {
					this.logger.debug(
						`File hash of ${relativePath} matches with last synced version and the path hasn't changed; no need to sync`
					);
					return;
				}

				// Re-fetch based on the documentId instead of the relativePath because
				// the relativePath might have changed since this operation was scheduled
				let latestMetadata = this.database.getDocumentByDocumentId(
					localMetadata.documentId
				);
				if (!latestMetadata || latestMetadata[1].isDeleted) {
					// It's fine, a subsequent sync operation must have dealt with this
					return;
				}

				const response = await this.syncService.put({
					documentId: latestMetadata[1].documentId,
					parentVersionId: latestMetadata[1].parentVersionId,
					relativePath: latestMetadata[0],
					contentBytes,
					createdDate: updateTime
				});

				latestMetadata = this.database.getDocumentByDocumentId(
					response.documentId
				);

				if (!latestMetadata || latestMetadata[1].isDeleted) {
					// The document has been deleted since this operation was scheduled
					return;
				}

				if (
					latestMetadata[1].parentVersionId >= response.vaultUpdateId
				) {
					this.logger.debug(
						`Document ${relativePath} is already more up to date than the fetched version`
					);
					return;
				}

				this.history.addHistoryEntry({
					status: SyncStatus.SUCCESS,
					source: SyncSource.PUSH,
					relativePath,
					message: `Successfully uploaded locally updated file to the remote server`,
					type: SyncType.UPDATE
				});

				if (response.isDeleted) {
					await this.operations.delete(relativePath);

					this.history.addHistoryEntry({
						status: SyncStatus.SUCCESS,
						source: SyncSource.PULL,
						relativePath,
						message:
							"The file we tried to update had been deleted remotely, therefore, we have deleted it locally",
						type: SyncType.DELETE
					});

					await this.database.setDocument({
						documentId: response.documentId,
						relativePath: latestMetadata[0],
						parentVersionId: response.vaultUpdateId,
						hash: EMPTY_HASH,
						isDeleted: true
					});

					await this.tryIncrementVaultUpdateId(
						response.vaultUpdateId
					);

					return;
				}

				if (
					latestMetadata[1].parentVersionId >= response.vaultUpdateId
				) {
					this.logger.debug(
						`Document ${relativePath} is already more up to date than the fetched version`
					);
					return;
				}

				if (response.relativePath != relativePath) {
					await this.operations.move(
						latestMetadata[0],
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
						relativePath,
						message: `The file we updated had been updated remotely, so we downloaded the merged version`,
						type: SyncType.UPDATE
					});
				}

				await this.database.setDocument({
					documentId: response.documentId,
					relativePath:
						response.relativePath != relativePath
							? response.relativePath
							: latestMetadata[0],
					parentVersionId: response.vaultUpdateId,
					hash: contentHash,
					isDeleted: response.isDeleted
				});

				await this.tryIncrementVaultUpdateId(response.vaultUpdateId);
			}
		);
	}

	public async unrestrictedSyncRemotelyUpdatedFile(
		remoteVersion: components["schemas"]["DocumentVersionWithoutContent"]
	): Promise<void> {
		await this.executeSync(
			[remoteVersion.relativePath],
			SyncType.UPDATE,
			SyncSource.PULL,
			async () => {
				const content = (
					await this.syncService.get({
						documentId: remoteVersion.documentId
					})
				).contentBase64;
				const contentBytes = deserialize(content);
				const contentHash = hash(contentBytes);

				const localMetadata = this.database.getDocumentByDocumentId(
					remoteVersion.documentId
				);
				if (
					localMetadata?.[1].documentId ===
						remoteVersion.documentId &&
					localMetadata[1].parentVersionId >
						remoteVersion.vaultUpdateId
				) {
					this.logger.info(
						`Document ${remoteVersion.relativePath} is already up to date`
					);
					return;
				}

				const localBytes = await this.operations.read(
					remoteVersion.relativePath
				); // this can throw FileNotFoundError
				const localHash = hash(localBytes);

				if (localHash !== localMetadata?.[1].hash) {
					this.logger.info(
						`Document ${remoteVersion.relativePath} has pending local changes, so we shouldn't update it here`
					);
					return;
				}

				if (!localMetadata || localMetadata[1].isDeleted) {
					if (remoteVersion.isDeleted) {
						this.logger.info(
							`Remotely deleted file hasn't been synced yet, so there's no need to delete it locally`
						);
						return;
					}

					await this.operations.create(
						remoteVersion.relativePath,
						contentBytes,
						remoteVersion.documentId
					);

					await this.database.setDocument({
						documentId: remoteVersion.documentId,
						relativePath: remoteVersion.relativePath,
						parentVersionId: remoteVersion.vaultUpdateId,
						hash: hash(contentBytes),
						isDeleted: remoteVersion.isDeleted
					});

					this.history.addHistoryEntry({
						status: SyncStatus.SUCCESS,
						source: SyncSource.PULL,
						relativePath: remoteVersion.relativePath,
						message: `Successfully downloaded remote file which hadn't existed locally`,
						type: SyncType.CREATE
					});
					return;
				}

				const [relativePath, metadata] = localMetadata;
				if (remoteVersion.vaultUpdateId <= metadata.parentVersionId) {
					this.logger.debug(
						`Document ${relativePath} is already up to date`
					);
					return;
				}

				if (remoteVersion.isDeleted) {
					await this.operations.delete(relativePath);

					this.history.addHistoryEntry({
						status: SyncStatus.SUCCESS,
						source: SyncSource.PULL,
						relativePath: remoteVersion.relativePath,
						message: `Successfully deleted remotely deleted file locally`,
						type: SyncType.DELETE
					});

					await this.database.setDocument({
						documentId: remoteVersion.documentId,
						relativePath: relativePath,
						parentVersionId: remoteVersion.vaultUpdateId,
						hash: EMPTY_HASH,
						isDeleted: true
					});

					return;
				}

				if (relativePath !== remoteVersion.relativePath) {
					// TODO: this can fail, that's bad
					await this.operations.move(
						// this can throw FileNotFoundError
						relativePath,
						remoteVersion.relativePath,
						remoteVersion.documentId
					);
				}

				// todo: why
				await this.operations.create(
					remoteVersion.relativePath,
					contentBytes,
					remoteVersion.documentId
				);

				await this.database.setDocument({
					documentId: remoteVersion.documentId,
					relativePath: remoteVersion.relativePath,
					parentVersionId: remoteVersion.vaultUpdateId,
					hash: contentHash,
					isDeleted: remoteVersion.isDeleted
				});

				this.history.addHistoryEntry({
					status: SyncStatus.SUCCESS,
					source: SyncSource.PULL,
					relativePath: remoteVersion.relativePath,
					message: `Successfully updated remotely updated file locally`,
					type: SyncType.UPDATE
				});
			}
		);
	}

	public async executeSync<T>(
		lockedPaths: RelativePath[],
		syncType: SyncType,
		syncSource: SyncSource,
		fn: () => Promise<T>
	): Promise<T | undefined> {
		const relativePath = lockedPaths[lockedPaths.length - 1];

		if (!this.settings.getSettings().isSyncEnabled) {
			this.logger.info(
				`Syncing is disabled, not syncing ${relativePath}`
			);
			return;
		}

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

	private async tryIncrementVaultUpdateId(
		responseVaultUpdateId: number
	): Promise<void> {
		if (this.database.getLastSeenUpdateId() === responseVaultUpdateId - 1) {
			await this.database.setLastSeenUpdateId(responseVaultUpdateId);
		}
	}
}
