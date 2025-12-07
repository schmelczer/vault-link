import Watcher from "watcher";
import * as path from "path";
import type { SyncClient, RelativePath } from "sync-client";

export class FileWatcher {
    private watcher: Watcher | undefined;
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

        this.watcher = new Watcher(this.basePath, {
            recursive: true,
            renameDetection: true,
            renameTimeout: 125,
            ignoreInitial: true
        });

        this.watcher.on("add", (filePath: string) => {
            this.handleCreate(this.toRelativePath(filePath));
        });

        this.watcher.on("change", (filePath: string) => {
            this.handleChange(this.toRelativePath(filePath));
        });

        this.watcher.on("unlink", (filePath: string) => {
            this.handleDelete(this.toRelativePath(filePath));
        });

        this.watcher.on("rename", (oldPath: string, newPath: string) => {
            this.handleRename(
                this.toRelativePath(oldPath),
                this.toRelativePath(newPath)
            );
        });

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

    private handleCreate(relativePath: RelativePath): void {
        this.client
            .syncLocallyCreatedFile(relativePath)
            .catch((err: unknown) => {
                this.client.logger.error(
                    `Failed to sync created file ${relativePath}: ${this.formatError(err)}`
                );
            });
    }

    private handleChange(relativePath: RelativePath): void {
        this.client
            .syncLocallyUpdatedFile({ relativePath })
            .catch((err: unknown) => {
                this.client.logger.error(
                    `Failed to sync updated file ${relativePath}: ${this.formatError(err)}`
                );
            });
    }

    private handleDelete(relativePath: RelativePath): void {
        this.client
            .syncLocallyDeletedFile(relativePath)
            .catch((err: unknown) => {
                this.client.logger.error(
                    `Failed to sync deleted file ${relativePath}: ${this.formatError(err)}`
                );
            });
    }

    private handleRename(oldPath: RelativePath, newPath: RelativePath): void {
        this.client.logger.info(`File renamed: ${oldPath} -> ${newPath}`);
        this.client
            .syncLocallyUpdatedFile({
                oldPath,
                relativePath: newPath
            })
            .catch((err: unknown) => {
                this.client.logger.error(
                    `Failed to sync renamed file ${oldPath} -> ${newPath}: ${this.formatError(err)}`
                );
            });
    }

    private toRelativePath(absolutePath: string): RelativePath {
        const relative = path.relative(this.basePath, absolutePath);
        return this.toUnixPath(relative);
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

    private formatError(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }
}
