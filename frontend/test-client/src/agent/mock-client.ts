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
        updater: (currentContent: TextWithCursors) => TextWithCursors
    ): Promise<string> {
        // This method is called by BOTH the sync client (for remote text
        // merges) and the test agent (for user updates). We must NOT call
        // executeFileOperation here because the sync-client path would
        // echo remote writes back as local modifications, creating an
        // infinite sync loop. The test agent calls executeFileOperation
        // separately after this method returns.
        const file = this.files.get(path);
        if (!file) {
            throw new Error(`File ${path} does not exist`);
        }
        const currentContent = new TextDecoder().decode(file);
        const newContent = updater({ text: currentContent, cursors: [] }).text;
        const newContentUint8Array = new TextEncoder().encode(newContent);
        this.files.set(path, newContentUint8Array);

        return newContent;
    }

    public override async write(
        path: RelativePath,
        content: Uint8Array
    ): Promise<void> {
        // This method is called by the sync client when writing files
        // received from the server (remote updates). Do NOT call
        // executeFileOperation here — that would echo the remote write
        // back as a local modification, creating an infinite sync loop.
        // User-initiated writes go through create(), atomicUpdateText(),
        // or direct files.set() + executeFileOperation() in mock-agent.
        this.files.set(path, content);
    }

    public override async delete(path: RelativePath): Promise<void> {
        // Just perform the filesystem operation. The test agent calls
        // executeFileOperation separately in mock-agent.ts. Not echoing
        // here prevents the sync client's remote-delete writes from
        // triggering spurious local-delete sync operations.
        this.files.delete(path);
    }

    public override async rename(
        oldPath: RelativePath,
        newPath: RelativePath
    ): Promise<void> {
        // Just perform the filesystem operation. The test agent calls
        // executeFileOperation separately in mock-agent.ts. Not echoing
        // here prevents the sync client's ensureClearPath / remote-rename
        // writes from triggering spurious local-update sync operations.
        const file = this.files.get(oldPath);
        if (!file) {
            throw new Error(`File ${oldPath} does not exist`);
        }
        this.files.set(newPath, file);
        if (oldPath !== newPath) {
            this.files.delete(oldPath);
        }
    }

    protected executeFileOperation(
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
