import type { Database, RelativePath } from "../persistence/database";
import type { SyncService } from "src/services/sync-service";
import type { Logger } from "src/tracing/logger";
import type { SyncHistory } from "src/tracing/sync-history";
import PQueue from "p-queue";
import { hash } from "src/utils/hash";
import type { components } from "src/services/types";
import type { Settings } from "src/persistence/settings";
import type { FileOperations } from "src/file-operations/file-operations";
import { findMatchingFile } from "src/utils/find-matching-file";
import { UnrestrictedSyncer } from "./unrestricted-syncer";
import { FileNotFoundError } from "src/file-operations/safe-filesystem-operations";
import { createPromise } from "src/utils/create-promise";

export class Syncer {
	private readonly remainingOperationsListeners: ((
		remainingOperations: number
	) => void)[] = [];

	private readonly syncQueue: PQueue;

	private runningScheduleSyncForOfflineChanges: Promise<void> | undefined;
	private runningApplyRemoteChangesLocally: Promise<void> | undefined;

	private readonly internalSyncer: UnrestrictedSyncer;

	public constructor(
		private readonly logger: Logger,
		private readonly database: Database,
		private readonly settings: Settings,
		private readonly syncService: SyncService,
		private readonly operations: FileOperations,
		history: SyncHistory
	) {
		this.syncQueue = new PQueue({
			concurrency: settings.getSettings().syncConcurrency
		});

		settings.addOnSettingsChangeHandlers((newSettings, oldSettings) => {
			if (newSettings.syncConcurrency === oldSettings.syncConcurrency) {
				return;
			}
			this.syncQueue.concurrency = newSettings.syncConcurrency;
		});

		this.syncQueue.on("active", () => {
			this.emitRemainingOperationsChange(this.syncQueue.size);
		});

		this.internalSyncer = new UnrestrictedSyncer(
			logger,
			database,
			settings,
			syncService,
			operations,
			history
		);
	}

	private static async forgivingFileNotFoundWrapper<T>(
		fn: () => Promise<T>,
		logger: Logger
	): Promise<T | undefined> {
		try {
			return await fn();
		} catch (e) {
			if (e instanceof FileNotFoundError) {
				logger.debug(
					`File has been deleted or moved before we had a chance to inspect it, skipping`
				);
				return undefined;
			}

			throw e;
		}
	}

	public addRemainingOperationsListener(
		listener: (remainingOperations: number) => void
	): void {
		this.remainingOperationsListeners.push(listener);
	}

	public async syncLocallyCreatedFile(
		relativePath: RelativePath,
		updateTime?: Date
	): Promise<void> {
		if (!this.settings.getSettings().isSyncEnabled) {
			this.logger.info(
				`Syncing is disabled, not syncing '${relativePath}'`
			);
			return;
		}

		const [promise, resolve, reject] = createPromise();

		// Most likely, we're waiting for the previous delete to finish on the file at this path
		await this.database.getResolvedDocumentByRelativePath(
			relativePath,
			promise
		);

		try {
			await this.syncQueue.add(async () =>
				this.internalSyncer.unrestrictedSyncLocallyCreatedFile(
					() => this.database.getDocumentByUpdatePromise(promise),
					updateTime
				)
			);

			resolve();
		} catch (e) {
			reject(e);
		} finally {
			this.database.removeDocumentPromise(promise);
		}
	}

	public async syncLocallyDeletedFile(
		relativePath: RelativePath
	): Promise<void> {
		if (!this.settings.getSettings().isSyncEnabled) {
			this.logger.info(
				`Syncing is disabled, not syncing '${relativePath}'`
			);
			return;
		}

		this.database.delete(relativePath);

		const [promise, resolve, reject] = createPromise();

		await this.database.getResolvedDocumentByRelativePath(
			relativePath,
			promise
		);

		try {
			await this.syncQueue.add(async () =>
				this.internalSyncer.unrestrictedSyncLocallyDeletedFile(() => {
					this.logger.debug(
						`aaaahg ${relativePath} has been deleted locally, syncing to delete it`
					);

					return this.database.getDocumentByUpdatePromise(promise);
				})
			);

			resolve();
		} catch (e) {
			reject(e);
		} finally {
			this.database.removeDocumentPromise(promise);
		}
	}

	public async syncLocallyUpdatedFile({
		oldPath,
		relativePath,
		updateTime
	}: {
		oldPath?: RelativePath;
		relativePath: RelativePath;
		updateTime?: Date;
	}): Promise<void> {
		if (!this.settings.getSettings().isSyncEnabled) {
			this.logger.info(
				`Syncing is disabled, not syncing '${relativePath}'`
			);
			return;
		}

		const [promise, resolve, reject] = createPromise();

		if (oldPath !== undefined) {
			if (oldPath === relativePath) {
				throw new Error(
					`Old path and new path are the same: ${oldPath}`
				);
			}

			this.database.move(oldPath, relativePath);
		}

		await this.database.getResolvedDocumentByRelativePath(
			relativePath,
			promise
		);

		try {
			await this.syncQueue.add(async () =>
				this.internalSyncer.unrestrictedSyncLocallyUpdatedFile({
					oldPath,
					updateTime,
					getLatestDocument: () =>
						this.database.getDocumentByUpdatePromise(promise)
				})
			);

			resolve();
		} catch (e) {
			reject(e);
		} finally {
			this.database.removeDocumentPromise(promise);
		}
	}

	public async scheduleSyncForOfflineChanges(): Promise<void> {
		if (!this.settings.getSettings().isSyncEnabled) {
			this.logger.debug(
				`Syncing is disabled, not uploading local changes`
			);
			return;
		}

		if (this.runningScheduleSyncForOfflineChanges !== undefined) {
			this.logger.debug("Uploading local changes is already in progress");
			return this.runningScheduleSyncForOfflineChanges;
		}

		try {
			this.runningScheduleSyncForOfflineChanges =
				this.internalScheduleSyncForOfflineChanges();
			await this.runningScheduleSyncForOfflineChanges;
			this.logger.info(`All local changes have been applied remotely`);
		} catch (e) {
			this.logger.error(
				`Not all local changes have been applied remotely: ${e}`
			);
			throw e;
		} finally {
			this.runningScheduleSyncForOfflineChanges = undefined;
		}
	}

	public async applyRemoteChangesLocally(): Promise<void> {
		if (!this.settings.getSettings().isSyncEnabled) {
			this.logger.debug(
				`Syncing is disabled, not fetching remote changes`
			);
			return;
		}

		if (this.runningApplyRemoteChangesLocally != null) {
			this.logger.debug(
				"Applying remote changes locally is already in progress"
			);
			return this.runningApplyRemoteChangesLocally;
		}

		try {
			this.runningApplyRemoteChangesLocally =
				this.internalApplyRemoteChangesLocally();
			await this.runningApplyRemoteChangesLocally;
			this.logger.info("All remote changes have been applied locally");
		} catch (e) {
			this.logger.error(`Failed to apply remote changes locally: ${e}`);
			throw e;
		} finally {
			this.runningApplyRemoteChangesLocally = undefined;
		}
	}

	public async waitForSyncQueue(): Promise<void> {
		return this.syncQueue.onEmpty();
	}

	public async reset(): Promise<void> {
		this.syncQueue.clear();
		await this.syncQueue.onEmpty();
		this.remainingOperationsListeners.forEach((listener) => listener(0));
		this.internalSyncer.reset();
	}

	private async syncRemotelyUpdatedFile(
		remoteVersion: components["schemas"]["DocumentVersionWithoutContent"]
	): Promise<void> {
		let document = this.database.getDocumentByDocumentId(
			remoteVersion.documentId
		);

		if (document === undefined) {
			const candidate = this.database.getLatestDocumentByRelativePath(
				remoteVersion.relativePath
			);
			if (candidate !== undefined && candidate.metadata === undefined) {
				document = candidate;
			}
		}

		if (document === undefined) {
			await this.syncQueue.add(async () =>
				this.internalSyncer.unrestrictedSyncRemotelyUpdatedFile(
					remoteVersion
				)
			);

			return;
		}

		const [promise, resolve, reject] = createPromise();

		await this.database.getResolvedDocumentByRelativePath(
			document.relativePath,
			promise
		);

		try {
			await this.syncQueue.add(async () =>
				this.internalSyncer.unrestrictedSyncRemotelyUpdatedFile(
					remoteVersion,
					() => this.database.getDocumentByUpdatePromise(promise)
				)
			);

			resolve();
		} catch (e) {
			reject(e);
		} finally {
			this.database.removeDocumentPromise(promise);
		}
	}

	private async internalScheduleSyncForOfflineChanges(): Promise<void> {
		const allLocalFiles = await this.operations.listAllFiles();

		let locallyPossiblyDeletedFiles = [
			...this.database.resolvedDocuments
		].filter(({ relativePath }) => !allLocalFiles.includes(relativePath));

		const updates = Promise.all(
			allLocalFiles.map(async (relativePath) => {
				if (
					this.database.getLatestDocumentByRelativePath(relativePath)
						?.metadata !== undefined
				) {
					this.logger.debug(
						`Document ${relativePath} might have been updated locally, scheduling sync to validate and update it`
					);

					return this.syncLocallyUpdatedFile({
						relativePath
					});
				}

				// Perhaps the file has been moved; let's check by looking at the deleted files
				const contentHash = await this.syncQueue.add(async () => {
					const contentBytes =
						await Syncer.forgivingFileNotFoundWrapper(
							async () => this.operations.read(relativePath),
							this.logger
						);
					if (contentBytes === undefined) {
						return;
					}
					return hash(contentBytes);
				});

				if (contentHash == undefined) {
					// The file was deleted before we had a chance to read it, no need to sync it here
					return;
				}

				const originalFile = findMatchingFile(
					contentHash,
					locallyPossiblyDeletedFiles
				);
				if (originalFile !== undefined) {
					// `originalFile` hasn't been deleted but it got moved instead
					locallyPossiblyDeletedFiles =
						locallyPossiblyDeletedFiles.filter(
							(item) =>
								item.relativePath !== originalFile.relativePath
						);

					this.logger.debug(
						`Document '${originalFile.relativePath}' was not found under its current path in the database but was found under a different path (${relativePath}), scheduling sync to move it`
					);

					// We're outside of the pqueue, so we need to call the public wrapper
					return this.syncLocallyUpdatedFile({
						oldPath: originalFile.relativePath,
						relativePath
					});
				}

				this.logger.debug(
					`Document ${relativePath} not found in database, scheduling sync to create it`
				);
				// We're outside of the pqueue, so we need to call the public wrapper
				return this.syncLocallyCreatedFile(relativePath);
			})
		);

		const deletes = Promise.all(
			locallyPossiblyDeletedFiles.map(async ({ relativePath }) => {
				this.logger.debug(
					`Document ${relativePath} has been deleted locally, scheduling sync to delete it`
				);

				// We're outside of the pqueue, so we need to call the public wrapper
				return this.syncLocallyDeletedFile(relativePath);
			})
		);

		await Promise.all([updates, deletes]);
	}

	private async internalApplyRemoteChangesLocally(): Promise<void> {
		const remote = await this.syncService.getAll(
			this.database.getLastSeenUpdateId()
		);

		if (remote.latestDocuments.length === 0) {
			this.logger.debug("No remote changes to apply");
			return;
		}

		this.logger.info("Applying remote changes locally");

		await Promise.all(
			remote.latestDocuments.map(this.syncRemotelyUpdatedFile.bind(this))
		);

		const lastSeenUpdateId = this.database.getLastSeenUpdateId();
		if (
			lastSeenUpdateId === undefined ||
			remote.lastUpdateId > lastSeenUpdateId
		) {
			this.database.setLastSeenUpdateId(remote.lastUpdateId);
		}
	}

	private emitRemainingOperationsChange(remainingOperations: number): void {
		this.remainingOperationsListeners.forEach((listener) => {
			listener(remainingOperations);
		});
	}
}
