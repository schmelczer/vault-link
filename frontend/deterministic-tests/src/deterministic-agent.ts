import type {
    StoredDatabase,
    SyncSettings,
    RelativePath,
    TextWithCursors
} from "sync-client";
import { SyncClient, debugging, LogLevel, utils } from "sync-client";
import { assert } from "./utils/assert";
import { sleep } from "./utils/sleep";
import { withTimeout } from "./utils/with-timeout";
import {
    IS_SYNC_ENABLED_BY_DEFAULT,
    WAIT_TIMEOUT_MS,
    WEBSOCKET_CONNECT_TIMEOUT_MS,
    WEBSOCKET_POLL_INTERVAL_MS
} from "./consts";
import { ManagedWebSocketFactory } from "./managed-websocket";

export class DeterministicAgent extends debugging.InMemoryFileSystem {
    public readonly clientId: number;
    private readonly logger: (msg: string) => void;
    private client!: SyncClient;
    private data: Partial<{
        settings: Partial<SyncSettings>;
        database: Partial<StoredDatabase>;
    }> = {};
    private isSyncEnabled = IS_SYNC_ENABLED_BY_DEFAULT;
    private readonly syncErrors: Error[] = [];
    private readonly pendingSyncOperations = new Set<Promise<void>>();
    private readonly wsFactory = new ManagedWebSocketFactory();

    public constructor(
        clientId: number,
        initialSettings: Partial<SyncSettings>,
        logger: (msg: string) => void
    ) {
        super();
        this.clientId = clientId;
        this.logger = logger;
        this.data.settings = { ...initialSettings };
    }

    public async init(
        fetchImplementation: typeof globalThis.fetch
    ): Promise<void> {
        this.client = await SyncClient.create({
            fs: this,
            persistence: {
                load: async () => this.data,
                save: async (data) => void (this.data = data)
            },
            fetch: fetchImplementation,
            webSocket: this.wsFactory.constructorFn
        });

        this.client.logger.onLogEmitted.add((line) => {
            const prefix = `[Client ${this.clientId}]`;
            switch (line.level) {
                case LogLevel.ERROR:
                    this.logger(`${prefix} ERROR: ${line.message}`);
                    break;
                case LogLevel.WARNING:
                    this.logger(`${prefix} WARN: ${line.message}`);
                    break;
                case LogLevel.INFO:
                    this.logger(`${prefix} ${line.message}`);
                    break;
                case LogLevel.DEBUG:
                    // Skip debug logs to reduce noise
                    break;
            }
        });

        await this.client.start();

        const connectionCheck = await this.client.checkConnection();
        assert(
            connectionCheck.isSuccessful,
            `Client ${this.clientId} connection check failed`
        );

        if (this.isSyncEnabled) {
            await this.waitForWebSocket();
        }
    }

    public pauseWebSocket(): void {
        this.log("Pausing WebSocket message delivery");
        this.wsFactory.pause();
    }

    public resumeWebSocket(): void {
        this.log("Resuming WebSocket message delivery");
        this.wsFactory.resume();
    }

    public async waitForSync(): Promise<void> {
        this.log("Waiting for sync to complete...");
        // Drain agent-level sync operations first. These are the fire-and-forget
        // promises from enqueueSync() that call into the SyncClient's methods.
        // Without this, waitUntilFinished() might return before the SyncClient
        // has even been told about the operation.
        await this.drainPendingSyncOperations();
        await withTimeout(
            this.client.waitUntilFinished(),
            WAIT_TIMEOUT_MS,
            `Client ${this.clientId} waitForSync timed out after ${WAIT_TIMEOUT_MS}ms`
        );
        if (this.syncErrors.length > 0) {
            const errors = this.syncErrors.splice(0);
            throw new Error(
                `Client ${this.clientId} had ${errors.length} sync error(s):\n${errors.map((e) => e.message).join("\n")}`
            );
        }
        this.log("Sync complete");
    }

    public async disableSync(): Promise<void> {
        this.log("Disabling sync");
        // Drain pending enqueued operations before disabling so the SyncClient
        // knows about all operations that were enqueued while sync was enabled.
        await this.drainPendingSyncOperations();
        await this.client.setSetting("isSyncEnabled", false);
        this.isSyncEnabled = false;
        // Wait for in-flight operations to drain. Disabling sync triggers
        // a reset, which aborts in-flight fetches with SyncResetError.
        try {
            await withTimeout(
                this.client.waitUntilFinished(),
                WAIT_TIMEOUT_MS,
                `Client ${this.clientId} disableSync drain timed out`
            );
        } catch (error) {
            if (error instanceof Error && error.name === "SyncResetError") {
                this.log("Disable sync drain interrupted by reset (expected)");
            } else {
                throw error;
            }
        }
    }

    public async enableSync(): Promise<void> {
        this.log("Enabling sync");
        await this.client.setSetting("isSyncEnabled", true);
        this.isSyncEnabled = true;
        await this.waitForWebSocket();
    }

    public async getFileContent(path: string): Promise<string> {
        const bytes = await this.read(path);
        return new TextDecoder().decode(bytes);
    }

    public async cleanup(): Promise<void> {
        this.log("Cleaning up...");
        // Guard against uninitialized client (init() failed partway).
        // The class field uses `!:` so TS thinks this is always defined,
        // but at runtime it can be undefined when init() throws partway.
        const maybeClient = this.client as SyncClient | undefined;
        if (maybeClient === undefined) {
            this.log("Client not initialized, nothing to clean up");
            return;
        }
        try {
            await this.drainPendingSyncOperations();
            await withTimeout(
                this.client.waitUntilFinished(),
                WAIT_TIMEOUT_MS,
                `Client ${this.clientId} cleanup waitUntilFinished timed out`
            );
        } catch (error) {
            if (error instanceof Error && error.name === "SyncResetError") {
                this.log(`Cleanup interrupted by reset (expected): ${error}`);
            } else {
                this.log(`Cleanup waitUntilFinished failed: ${error}`);
            }
        }
        await this.client.destroy();
        this.log("Cleanup complete");
    }

    public override async read(path: RelativePath): Promise<Uint8Array> {
        await Promise.resolve();
        return super.read(path);
    }

    public override async write(
        path: RelativePath,
        content: Uint8Array
    ): Promise<void> {
        await Promise.resolve();
        const isNew = !this.files.has(path);
        await super.write(path, content);

        if (isNew) {
            this.enqueueSync(async () => {
                this.client.syncLocallyCreatedFile(path);
            });
        } else {
            this.enqueueSync(async () => {
                this.client.syncLocallyUpdatedFile({ relativePath: path });
            });
        }
    }

    public override async atomicUpdateText(
        path: RelativePath,
        updater: (current: TextWithCursors) => TextWithCursors
    ): Promise<string> {
        const result = await super.atomicUpdateText(path, updater);
        this.enqueueSync(async () => {
            this.client.syncLocallyUpdatedFile({ relativePath: path });
        });
        return result;
    }

    public override async delete(path: RelativePath): Promise<void> {
        await super.delete(path);
        if (this.isSyncEnabled) {
            this.enqueueSync(async () => {
                this.client.syncLocallyDeletedFile(path);
            });
        }
    }

    public override async rename(
        oldPath: RelativePath,
        newPath: RelativePath
    ): Promise<void> {
        await super.rename(oldPath, newPath);
        this.enqueueSync(async () => {
            this.client.syncLocallyUpdatedFile({
                oldPath,
                relativePath: newPath
            });
        });
    }

    private async waitForWebSocket(): Promise<void> {
        const deadline = Date.now() + WEBSOCKET_CONNECT_TIMEOUT_MS;
        while (!this.client.isWebSocketConnected && Date.now() < deadline) {
            await sleep(WEBSOCKET_POLL_INTERVAL_MS);
        }
        assert(
            this.client.isWebSocketConnected,
            `Client ${this.clientId} WebSocket failed to connect within ${WEBSOCKET_CONNECT_TIMEOUT_MS}ms`
        );
    }

    /**
     * Wait until all agent-level enqueued sync operations have completed.
     * Uses a loop because completing one operation can trigger new enqueues.
     */
    private async drainPendingSyncOperations(): Promise<void> {
        while (this.pendingSyncOperations.size > 0) {
            await utils.awaitAll([...this.pendingSyncOperations]);
        }
    }

    private enqueueSync(operation: () => Promise<void>): void {
        const promise = this.executeSyncOperation(operation).catch(
            (error: unknown) => {
                const err =
                    error instanceof Error ? error : new Error(String(error));
                this.log(`Background sync failed: ${err.message}`);
                this.syncErrors.push(err);
            }
        );
        this.pendingSyncOperations.add(promise);
        void promise.finally(() => {
            this.pendingSyncOperations.delete(promise);
        });
    }

    private async executeSyncOperation(
        operation: () => Promise<void>
    ): Promise<void> {
        try {
            await operation();
        } catch (error) {
            if (error instanceof Error && error.name === "SyncResetError") {
                this.log(`Sync operation interrupted by reset: ${error}`);
                return;
            }
            if (
                error instanceof Error &&
                error.message.includes("has been destroyed")
            ) {
                this.log(`Sync operation interrupted by destroy: ${error}`);
                return;
            }

            throw error;
        }
    }

    private log(message: string): void {
        this.logger(`[Client ${this.clientId}] ${message}`);
    }
}
