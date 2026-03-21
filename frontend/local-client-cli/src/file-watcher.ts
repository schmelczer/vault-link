import Watcher from "watcher";
import * as path from "path";
import type { SyncClient, RelativePath } from "sync-client";
import { toUnixPath, compileGlobPattern } from "./path-utils";

export class FileWatcher {
    private watcher: Watcher | undefined;
    private isRunning = false;
    private readonly compiledPatterns: RegExp[];

    public constructor(
        private readonly basePath: string,
        private readonly client: SyncClient,
        ignorePatterns: string[] = []
    ) {
        this.compiledPatterns = ignorePatterns.map(compileGlobPattern);
    }

    public start(): void {
        if (this.isRunning) {
            return;
        }

        this.isRunning = true;

        this.watcher = new Watcher(this.basePath, {
            recursive: true,
            renameDetection: true,
            renameTimeout: 125,
            ignoreInitial: true,
            ignore: (filePath: string): boolean =>
                this.shouldIgnore(filePath)
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

    private shouldIgnore(filePath: string): boolean {
        const rel = toUnixPath(path.relative(this.basePath, filePath));
        return this.compiledPatterns.some((regex) => regex.test(rel));
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
        return toUnixPath(path.relative(this.basePath, absolutePath));
    }

    private formatError(err: unknown): string {
        return err instanceof Error ? err.message : String(err);
    }
}
