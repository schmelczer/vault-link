import * as fs from "fs";
import * as path from "path";
import type { SyncClient, RelativePath } from "sync-client";

export class FileWatcher {
	private watcher: fs.FSWatcher | undefined;
	private isRunning = false;

	public constructor(
		private readonly basePath: string,
		private readonly client: SyncClient
	) {}

	public start(): void {
		if (this.isRunning) {
			return;
		}

		this.isRunning = true;

		this.watcher = fs.watch(
			this.basePath,
			{ recursive: true },
			(eventType, filename) => {
				if (filename === null || filename.length === 0) {
					return;
				}

				// Convert to forward slashes for consistency
				const relativePath = this.toUnixPath(filename);

				if (eventType === "rename") {
					this.handleRenameOrDelete(relativePath);
				} else {
					// Must be "change" event
					this.handleChange(relativePath);
				}
			}
		);

		this.client.logger.info("File watcher started");
	}

	public stop(): void {
		if (this.watcher !== undefined) {
			this.watcher.close();
			this.watcher = undefined;
		}
		this.isRunning = false;
		this.client.logger.info("File watcher stopped");
	}

	private handleChange(relativePath: RelativePath): void {
		this.client
			.syncLocallyUpdatedFile({ relativePath })
			.catch((err: unknown) => {
				this.client.logger.error(
					`Failed to sync updated file ${relativePath}: ${err instanceof Error ? err.message : String(err)}`
				);
			});
	}

	private handleRenameOrDelete(relativePath: RelativePath): void {
		const fullPath = path.join(this.basePath, relativePath);

		fs.access(fullPath, fs.constants.F_OK, (accessError) => {
			if (accessError) {
				this.client
					.syncLocallyDeletedFile(relativePath)
					.catch((deleteErr: unknown) => {
						this.client.logger.error(
							`Failed to sync deleted file ${relativePath}: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`
						);
					});
			} else {
				fs.stat(fullPath, (statErr, stats) => {
					if (statErr !== null || !stats.isFile()) {
						return;
					}

					this.client
						.syncLocallyCreatedFile(relativePath)
						.catch((createErr: unknown) => {
							this.client.logger.error(
								`Failed to sync created file ${relativePath}: ${createErr instanceof Error ? createErr.message : String(createErr)}`
							);
						});
				});
			}
		});
	}

	/**
	 * Convert a native platform path to forward slashes
	 */
	private toUnixPath(nativePath: string): string {
		if (path.sep === "\\") {
			return nativePath.replace(/\\/g, "/");
		}
		return nativePath;
	}
}
