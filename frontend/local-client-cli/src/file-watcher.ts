import Watcher from "watcher";
import * as path from "node:path";
import type { SyncClient } from "sync-client";
import { toUnixPath, matchesGlob } from "./path-utils";

/** OS events include sync writes and editor temporary-file replacements. They
 * wake reconciliation; only a fresh scan determines the current namespace. */
export class FileWatcher {
    private watcher: Watcher | undefined;

    public constructor(
        private readonly basePath: string,
        private readonly client: SyncClient,
        private readonly ignorePatterns: string[] = []
    ) {}

    public start(): void {
        if (this.watcher) return;
        this.watcher = new Watcher(this.basePath, {
            recursive: true,
            renameDetection: false,
            ignoreInitial: true,
            ignore: (filePath: string): boolean =>
                this.ignorePatterns.some((pattern) =>
                    matchesGlob(this.toRelativePath(filePath), pattern)
                )
        });
        this.watcher.on("all", (_event: string, filePath: string) => {
            void this.client
                .syncLocallyUpdatedFile({
                    relativePath: this.toRelativePath(filePath)
                })
                .catch((error: unknown) => {
                    this.client.logger.error(
                        `File notification failed: ${error}`
                    );
                });
        });
        this.watcher.on("error", (error: Error) => {
            this.client.logger.error(`File watcher failed: ${error.message}`);
        });
        this.client.logger.info("File watcher started");
    }

    public stop(): void {
        this.watcher?.close();
        this.watcher = undefined;
        this.client.logger.info("File watcher stopped");
    }

    private toRelativePath(absolutePath: string): string {
        return toUnixPath(path.relative(this.basePath, absolutePath));
    }
}
