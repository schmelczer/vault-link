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

    public override async write(
        path: RelativePath,
        content: Uint8Array
    ): Promise<void> {
        const isNew = !this.files.has(path);

        this.files.set(path, content);

        if (isNew) {
            this.executeFileOperation(async () => {
                this.client.syncLocallyCreatedFile(path);
            });
        } else {
            this.executeFileOperation(async () => {
                this.client.syncLocallyUpdatedFile({ relativePath: path });
            });
        }
    }

    public override async atomicUpdateText(
        path: RelativePath,
        updater: (currentContent: TextWithCursors) => TextWithCursors
    ): Promise<string> {
        const file = this.files.get(path);
        if (!file) {
            throw new Error(`File ${path} does not exist`);
        }
        const currentContent = new TextDecoder().decode(file);
        const newContent = updater({ text: currentContent, cursors: [] }).text;
        const newContentUint8Array = new TextEncoder().encode(newContent);
        this.files.set(path, newContentUint8Array);

        this.executeFileOperation(async () => {
            this.client.syncLocallyUpdatedFile({ relativePath: path });
        });

        return newContent;
    }

    public override async delete(path: RelativePath): Promise<void> {
        this.files.delete(path);
        this.executeFileOperation(async () => {
            this.client.syncLocallyDeletedFile(path);
        });
    }

    public override async rename(
        oldPath: RelativePath,
        newPath: RelativePath
    ): Promise<void> {
        const file = this.files.get(oldPath);
        if (!file) {
            throw new Error(`File ${oldPath} does not exist`);
        }
        this.files.set(newPath, file);
        if (oldPath !== newPath) {
            this.files.delete(oldPath);
        }
        this.executeFileOperation(async () => {
            this.client.syncLocallyUpdatedFile({
                oldPath,
                relativePath: newPath
            });
        });
    }

    protected executeFileOperation(callback: () => unknown): void {
        if (this.useSlowFileEvents) {
            // we aren't the best client and it takes some time to notice changes
            setTimeout(callback, Math.random() * 100);
        } else {
            callback();
        }
    }
}
