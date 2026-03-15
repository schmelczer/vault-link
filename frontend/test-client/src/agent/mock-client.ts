import type { StoredDatabase, TextWithCursors } from "sync-client";
import { assert } from "../utils/assert";
import {
    type RelativePath,
    type SyncSettings,
    SyncClient,
    debugging
} from "sync-client";

export class MockClient extends debugging.InMemoryFileSystem {
    protected client!: SyncClient;

    protected data: Partial<{
        settings: Partial<SyncSettings>;
        database: Partial<StoredDatabase>;
    }> = {};

    public constructor(
        initialSettings: Partial<SyncSettings>,
        protected readonly useSlowFileEvents: boolean
    ) {
        super();
        this.data.settings = initialSettings;
    }

    public async init(
        fetchImplementation: typeof globalThis.fetch,
        webSocketImplementation: typeof globalThis.WebSocket
    ): Promise<void> {
        this.client = await SyncClient.create({
            fs: this,
            persistence: {
                load: async () => this.data,
                save: async (data) => void (this.data = data)
            },
            fetch: fetchImplementation,
            webSocket: webSocketImplementation
        });

        await this.client.start();
    }

    public async create(
        path: RelativePath,
        newContent: Uint8Array,
        { ignoreSlowFileEvents }: { ignoreSlowFileEvents: boolean } = {
            ignoreSlowFileEvents: false
        }
    ): Promise<void> {
        if (this.files.has(path)) {
            throw new Error(`File ${path} already exists`);
        }
        this.client.logger.info(
            `Creating file ${path} with content ${new TextDecoder().decode(newContent)}`
        );
        this.files.set(path, newContent);

        this.executeFileOperation(
            async () => this.client.syncLocallyCreatedFile(path),
            ignoreSlowFileEvents
        );
    }

    public override async atomicUpdateText(
        path: RelativePath,
        updater: (currentContent: TextWithCursors) => TextWithCursors,
        { ignoreSlowFileEvents }: { ignoreSlowFileEvents: boolean } = {
            ignoreSlowFileEvents: false
        }
    ): Promise<string> {
        const file = this.files.get(path);
        if (!file) {
            throw new Error(`File ${path} does not exist`);
        }
        const currentContent = new TextDecoder().decode(file);
        const newContent = updater({ text: currentContent, cursors: [] }).text;
        const newContentUint8Array = new TextEncoder().encode(newContent);
        this.files.set(path, newContentUint8Array);

        if (!this.useSlowFileEvents) {
            const existingParts = currentContent
                .split(" ")
                .map((part) => part.trim());
            const newParts = newContent.split(" ").map((part) => part.trim());
            existingParts.forEach((part) =>
            // all changes should be additive
            {
                assert(
                    newParts.includes(part),
                    `Part ${part} not found in new content: '${newContent}'`
                );
            }
            );
        }

        this.client.logger.info(
            `Updated file ${path} with:\n  current content: '${currentContent}'\n  new content: '${newContent}'`
        );

        this.executeFileOperation(
            async () =>
                this.client.syncLocallyUpdatedFile({
                    relativePath: path
                }),
            ignoreSlowFileEvents
        );

        return newContent;
    }

    public override async write(
        path: RelativePath,
        content: Uint8Array
    ): Promise<void> {
        const hasExisted = this.files.has(path);
        this.files.set(path, content);

        this.client.logger.info(
            `Updated file ${path} with:\n  new content: ${new TextDecoder().decode(content)}`
        );

        this.executeFileOperation(async () => {
            if (hasExisted) {
                return this.client.syncLocallyUpdatedFile({
                    relativePath: path
                });
            } else {
                return this.client.syncLocallyCreatedFile(path);
            }
        });
    }

    public override async delete(
        path: RelativePath,
        { ignoreSlowFileEvents }: { ignoreSlowFileEvents: boolean } = {
            ignoreSlowFileEvents: false
        }
    ): Promise<void> {
        this.client.logger.info(
            `Deleting file: ${path} with:\n  content '${new TextDecoder().decode(this.files.get(path))}'`
        );
        this.files.delete(path);

        this.executeFileOperation(
            async () => this.client.syncLocallyDeletedFile(path),
            ignoreSlowFileEvents
        );
    }

    public override async rename(
        oldPath: RelativePath,
        newPath: RelativePath,
        { ignoreSlowFileEvents }: { ignoreSlowFileEvents: boolean } = {
            ignoreSlowFileEvents: false
        }
    ): Promise<void> {
        const file = this.files.get(oldPath);
        if (!file) {
            throw new Error(`File ${oldPath} does not exist`);
        }
        this.files.set(newPath, file);
        if (oldPath !== newPath) {
            this.files.delete(oldPath);
        }

        this.client.logger.info(
            `Renamed file: ${oldPath} -> ${newPath} with:\n  content ${new TextDecoder().decode(file)}`
        );

        this.executeFileOperation(
            async () =>
                this.client.syncLocallyUpdatedFile({
                    oldPath,
                    relativePath: newPath
                }),
            ignoreSlowFileEvents
        );
    }

    private executeFileOperation(
        callback: () => unknown,
        ignoreSlowFileEvents = false
    ): void {
        if (this.useSlowFileEvents && !ignoreSlowFileEvents) {
            // we aren't the best client and it takes some time to notice changes
            setTimeout(callback, Math.random() * 100);
        } else {
            callback();
        }
    }
}
