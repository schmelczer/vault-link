/* eslint-disable no-console */
import { choose } from "../utils/choose";
import { v4 as uuidv4 } from "uuid";
import { assert } from "../utils/assert";
import type { RelativePath, SyncSettings } from "sync-client";
import { debugging, Logger, LogLevel, utils } from "sync-client";
import { MockClient } from "./mock-client";
import { sleep } from "../utils/sleep";
import type { LogLine } from "sync-client";
import { withTimeout } from "../utils/with-timeout";

const TIMEOUT_MS = 10 * 60 * 1000;

export class MockAgent extends MockClient {
    private readonly writtenContents: string[] = [];
    private readonly writtenBinaryContents: string[] = [];
    private readonly pendingActions: Promise<unknown>[] = [];

    // The renamed file finding algorithm isn't too smart so we can't both update and rename the same file
    private readonly doNotTouchWhileOffline: string[] = [];
    private lastSyncEnabledState = true;

    public constructor(
        initialSettings: Partial<SyncSettings>,
        public readonly name: string,
        private readonly doDeletes: boolean,
        private readonly doResets: boolean,
        useSlowFileEvents: boolean,
        private readonly jitterScaleInSeconds: number
    ) {
        super(initialSettings, useSlowFileEvents);
    }

    public async init(): Promise<void> {
        await super.init(
            debugging.slowFetchFactory(this.jitterScaleInSeconds),
            debugging.slowWebSocketFactory(
                this.jitterScaleInSeconds,
                new Logger() // this logger isn't wired anywhere, so messages to it will be ignored
            )
        );

        assert(
            (await this.client.checkConnection()).isSuccessful,
            "Connection check failed"
        );

        this.client.logger.onLogEmitted.add((logLine: LogLine) => {
            const state = this.client.getSettings().isSyncEnabled
                ? "(online) "
                : "(offline)";
            const formatted = `[${this.name} ${state}] ${logLine.timestamp.toISOString()} ${logLine.level} ${logLine.message}`;

            // HACK: we have to ensure the file has been synced if we want to change it offline without data loss
            const historyEntry = /.*History entry: (.*\.(?:md|bin)).*/.exec(
                logLine.message
            );

            if (historyEntry) {
                utils.removeFromArray(
                    this.doNotTouchWhileOffline,
                    historyEntry[1]
                );
            }
            switch (logLine.level) {
                case LogLevel.ERROR:
                    console.error(formatted);

                    if (
                        !this.useSlowFileEvents &&
                        !formatted.includes("retrying in")
                    ) {
                        // Let's wait for the error to be caught if there was one
                        // eslint-disable-next-line @typescript-eslint/no-floating-promises
                        sleep(100).then(() => {
                            console.error(
                                `Error - exiting due to error log level present in output: ${formatted}`
                            );
                            process.exit(1);
                        });
                    }

                    break;
                case LogLevel.WARNING:
                    console.warn(formatted);
                    break;
                case LogLevel.INFO:
                    console.info(formatted);
                    break;
                case LogLevel.DEBUG:
                    console.debug(formatted);
                    break;
            }
        });

        this.client.logger.info("Agent initialized");
    }

    public async createInitialDocuments(count: number): Promise<void> {
        for (let i = 0; i < count; i++) {
            const file = `initial-${i}.md`;
            this.doNotTouchWhileOffline.push(file);
            const content = this.getContent();
            this.files.set(file, new TextEncoder().encode(` ${content} `));
        }
    }

    public async waitUntilSynced(): Promise<void> {
        await withTimeout(
            (async (): Promise<void> => {
                await this.client.setSetting("isSyncEnabled", true);
                await this.client.waitUntilFinished();
            })(),
            TIMEOUT_MS,
            "waitUntilSynced()"
        );
    }


    public async act(): Promise<void> {
        const options: (() => Promise<unknown>)[] = [
            this.createFileAction.bind(this),
            this.createBinaryFileAction.bind(this)
        ];

        if (
            this.lastSyncEnabledState &&
            this.doNotTouchWhileOffline.length === 0
        ) {
            options.push(this.disableSyncAction.bind(this));
        } else {
            options.push(this.enableSyncAction.bind(this));
        }


        options.push(
            this.renameFileAction.bind(this),
            this.updateFileAction.bind(this),
            this.updateBinaryFileAction.bind(this)
        );

        if (this.doDeletes) {
            options.push(this.deleteFileAction.bind(this));
        }


        if (Math.random() < 0.015 && this.doResets) {
            // we can't just queue this up as once it's destroyed, no more method calls can go to SyncClient
            await this.resetClient();
        } else {
            this.pendingActions.push(
                (async (): Promise<unknown> => {
                    try {
                        return await choose(options)();
                    } catch (error) {
                        this.client.logger.error(
                            `Failed to perform an action: ${error}`
                        );
                        this.client.logger.info(
                            JSON.stringify(this.data, null, 2)
                        );
                        this.client.logger.info(
                            JSON.stringify(this.files, null, 2)
                        );
                        throw error;
                    }
                })()
            );
        }
    }

    public async finish(): Promise<void> {
        await withTimeout(
            (async (): Promise<void> => {
                await this.client.setSetting("isSyncEnabled", true);
                await utils.awaitAll(this.pendingActions);
                await this.client.waitUntilFinished();
            })(),
            TIMEOUT_MS,
            "finish()"
        );
    }

    public async destroy(): Promise<void> {
        await withTimeout(
            (async (): Promise<void> => {
                await this.client.waitUntilFinished();
                await this.client.destroy();
            })(),
            TIMEOUT_MS,
            "destroy()"
        );
    }

    public assertFileSystemsAreConsistent(otherAgent: MockAgent): void {
        const globalFiles = Array.from(otherAgent.files.keys());
        const localFiles = Array.from(this.files.keys());

        const missingInOther = localFiles.filter(
            (file) => !otherAgent.files.has(file)
        );
        const missingInLocal = globalFiles.filter(
            (file) => !this.files.has(file)
        );

        try {
            assert(
                missingInOther.length === 0,
                `Files from ${this.name} missing in ${otherAgent.name}: ${missingInOther.join(", ")}`
            );
            assert(
                missingInLocal.length === 0,
                `Files from ${otherAgent.name} missing in ${this.name}: ${missingInLocal.join(", ")}`
            );

            for (const file of globalFiles) {
                const localContent = new TextDecoder().decode(
                    this.files.get(file)
                );
                const otherContent = new TextDecoder().decode(
                    otherAgent.files.get(file)
                );
                assert(
                    localContent === otherContent,
                    `Content mismatch for file ${file}:\n${localContent}\n${otherContent}`
                );
            }
        } catch (e) {
            this.client.logger.info(
                "Local data: " + JSON.stringify(this.data, null, 2)
            );
            this.client.logger.info(
                "Local files: " + Array.from(this.files.keys()).join(", ")
            );
            otherAgent.client.logger.info(
                "Other agent's data: " + JSON.stringify(otherAgent.data, null, 2)
            );
            otherAgent.client.logger.info(
                "Other agent's files: " + Array.from(otherAgent.files.keys()).join(", ")
            );

            throw e;
        }
    }

    // For slow file events, still check for duplicates (skip existence check).
    // Duplication is always a bug regardless of timing.
    public assertAllContentIsPresentOnce(): void {
        if (this.useSlowFileEvents) {
            this.client.logger.info(
                `Running partial content check for ${this.name} (slow file events: skipping existence check)`
            );
        }

        for (const content of this.writtenContents) {
            const found = Array.from(this.files.keys()).filter((key) => {
                return new TextDecoder()
                    .decode(this.files.get(key))
                    .includes(content);
            });

            assert(
                found.length <= 1,
                `[${this.name}] Content ${content} found in multiple files: ${found.join(", ")}`
            );

            if (!this.useSlowFileEvents && !this.doDeletes) {
                assert(
                    found.length >= 1,
                    `[${this.name}] Content ${content} not found in any files`
                );
            }

            if (found.length === 1) {
                const [file] = found;
                const fileContent = new TextDecoder().decode(
                    this.files.get(file)
                );
                assert(
                    fileContent.split(content).length == 2,
                    `Content ${content} (of ${this.name}) found more than once in '${file}'. File content:\n${fileContent}`
                );
            }
        }
    }

    // Check binary content isn't duplicated across files.
    // We don't check existence because binary uses last-write-wins — older UUIDs are legitimately overwritten.
    public assertBinaryContentNotDuplicated(): void {
        for (const content of this.writtenBinaryContents) {
            const found = Array.from(this.files.keys()).filter((key) => {
                return new TextDecoder()
                    .decode(this.files.get(key))
                    .includes(content);
            });

            assert(
                found.length <= 1,
                `[${this.name}] Binary content ${content} found in multiple files: ${found.join(", ")}`
            );
        }
    }

    public getFileList(): string[] {
        return Array.from(this.files.keys());
    }

    public getFileContent(path: string): Uint8Array | undefined {
        return this.files.get(path);
    }

    private async resetClient(): Promise<void> {
        this.client.logger.info(`Resetting client ${this.name}`);
        await this.client.destroy();
        await this.init();
    }

    private async createFileAction(): Promise<void> {
        const file = this.getFileName();

        if (
            (!this.lastSyncEnabledState &&
                this.doNotTouchWhileOffline.includes(file)) ||
            (await this.exists(file))
        ) {
            return;
        }

        const content = this.getContent();
        this.client.logger.info(
            `Decided to create file ${file} with content ${content}`
        );

        return this.create(file, new TextEncoder().encode(` ${content} `), {
            ignoreSlowFileEvents: true
        });
    }

    // Binary file creation — exercises the putBinary server path (not in mergeable_file_extensions)
    private async createBinaryFileAction(): Promise<void> {
        const file = this.getBinaryFileName();

        if (
            (!this.lastSyncEnabledState &&
                this.doNotTouchWhileOffline.includes(file)) ||
            (await this.exists(file))
        ) {
            return;
        }

        const content = this.getBinaryContent();
        this.client.logger.info(
            `Decided to create binary file ${file}`
        );

        return this.create(file, content, {
            ignoreSlowFileEvents: true
        });
    }

    private async disableSyncAction(): Promise<void> {
        this.client.logger.info(`Decided to disable sync`);
        this.lastSyncEnabledState = false;
        await this.client.setSetting("isSyncEnabled", false);
    }

    private async enableSyncAction(): Promise<void> {
        this.client.logger.info(`Decided to enable sync`);
        await this.client.setSetting("isSyncEnabled", true);
        this.lastSyncEnabledState = true;
    }

    private async renameFileAction(): Promise<void> {
        const files = await this.listFilesRecursively();
        if (files.length === 0) {
            return;
        }

        const file = choose(files);

        // We can't edit files offline that have been updated while offline.
        // Otherwise, the resolution logic couldn't handle it.
        if (
            !this.lastSyncEnabledState &&
            this.doNotTouchWhileOffline.includes(file)
        ) {
            this.client.logger.info(
                `Skipping file ${file} because it has been updated while offline`
            );
            return;
        }

        const newName = this.getFileName();

        if (
            (!this.lastSyncEnabledState &&
                this.doNotTouchWhileOffline.includes(newName)) ||
            (await this.exists(newName))
        ) {
            return;
        }

        this.client.logger.info(`Decided to rename file ${file} to ${newName}`);
        this.doNotTouchWhileOffline.push(file, newName);

        return this.rename(file, newName, { ignoreSlowFileEvents: true });
    }

    private async updateFileAction(): Promise<void> {
        const files = (await this.listFilesRecursively()).filter((f) =>
            f.endsWith(".md")
        );
        if (files.length === 0) {
            return;
        }

        const file = choose(files);

        // We can't edit files offline that have been updated while offline.
        // Otherwise, the resolution logic couldn't handle it.
        if (
            !this.lastSyncEnabledState &&
            this.doNotTouchWhileOffline.includes(file)
        ) {
            this.client.logger.info(
                `Skipping file ${file} because it has been updated while offline`
            );
            return;
        }

        const content = this.getContent();
        this.client.logger.info(
            `Decided to update file ${file} with ${content}`
        );
        this.doNotTouchWhileOffline.push(file);
        await this.atomicUpdateText(
            file,
            (old) => ({
                text: old.text + ` ${content} `,
                cursors: []
            }),
            { ignoreSlowFileEvents: true }
        );
    }

    // Binary file update — complete replacement (last-write-wins)
    private async updateBinaryFileAction(): Promise<void> {
        const files = (await this.listFilesRecursively()).filter((f) =>
            f.endsWith(".bin")
        );
        if (files.length === 0) {
            return;
        }

        const file = choose(files);

        if (
            !this.lastSyncEnabledState &&
            this.doNotTouchWhileOffline.includes(file)
        ) {
            return;
        }

        const content = this.getBinaryContent();
        this.client.logger.info(
            `Decided to update binary file ${file}`
        );
        this.doNotTouchWhileOffline.push(file);
        this.files.set(file, content);

        this.executeFileOperation(
            async () =>
                this.client.syncLocallyUpdatedFile({
                    relativePath: file
                }),
            true
        );
    }

    private async deleteFileAction(): Promise<void> {
        const files = await this.listFilesRecursively();
        if (files.length === 0) {
            return;
        }

        const file = choose(files);
        this.client.logger.info(`Decided to delete file ${file}`);
        return this.delete(file, { ignoreSlowFileEvents: true });
    }

    private getContent(): string {
        const uuid = uuidv4();
        this.writtenContents.push(uuid);
        return uuid;
    }

    private getBinaryContent(): Uint8Array {
        const uuid = uuidv4();
        this.writtenBinaryContents.push(uuid);
        return new TextEncoder().encode(`BINARY:${uuid}`);
    }

    private getFileName(): string {
        // Simulate name collisions between the clients
        return `file-${Math.floor(Math.random() * 64)}.md`;
    }

    private getBinaryFileName(): string {
        // Smaller range to increase collision frequency for last-write-wins testing
        return `binary-${Math.floor(Math.random() * 16)}.bin`;
    }
}
