import type { StoredDatabase, SyncSettings, RelativePath } from "sync-client";
import { SyncClient, debugging, LogLevel } from "sync-client";
import { assert } from "./utils/assert";
import { sleep } from "./utils/sleep";
import { withTimeout } from "./utils/with-timeout";
import { IS_SYNC_ENABLED_DEFAULT, WAIT_TIMEOUT_MS, WEBSOCKET_CONNECT_TIMEOUT_MS, WEBSOCKET_POLL_INTERVAL_MS } from "./consts";



export class DeterministicAgent extends debugging.InMemoryFileSystem {
    public readonly clientId: number;
    private readonly logger: (msg: string) => void;
    private client!: SyncClient;
    private data: Partial<{
        settings: Partial<SyncSettings>;
        database: Partial<StoredDatabase>;
    }> = {};
    private isSyncEnabled = IS_SYNC_ENABLED_DEFAULT;

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

    public async createFile(path: string, content: string): Promise<void> {
        this.log(`Creating file ${path} with content: ${content}`);
        if (this.files.has(path)) {
            throw new Error(`File ${path} already exists`);
        }
        const contentBytes = new TextEncoder().encode(content);
        this.files.set(path, contentBytes);

        this.enqueueSync(async () =>
            this.client.syncLocallyCreatedFile(path)
        );
    }

    public async updateFile(path: string, content: string): Promise<void> {
        this.log(`Updating file ${path} with content: ${content}`);
        if (!this.files.has(path)) {
            throw new Error(
                `File ${path} does not exist on client ${this.clientId}`
            );
        }
        const contentBytes = new TextEncoder().encode(content);
        this.files.set(path, contentBytes);

        this.enqueueSync(async () =>
            this.client.syncLocallyUpdatedFile({ relativePath: path })
        );
    }

    public async renameFile(oldPath: string, newPath: string): Promise<void> {
        this.log(`Renaming file ${oldPath} to ${newPath}`);
        const file = this.files.get(oldPath);
        if (!file) {
            throw new Error(
                `File ${oldPath} does not exist on client ${this.clientId}`
            );
        }
        if (oldPath !== newPath && this.files.has(newPath)) {
            this.log(
                `Target path ${newPath} already exists, will be overwritten (ensureClearPath)`
            );
        }
        this.files.set(newPath, file);
        if (oldPath !== newPath) {
            this.files.delete(oldPath);
        }
        if (this.isSyncEnabled) {
            this.enqueueSync(async () =>
                this.client.syncLocallyUpdatedFile({
                    oldPath,
                    relativePath: newPath
                })
            );
        }
    }

    public async deleteFile(path: string): Promise<void> {
        this.log(`Deleting file ${path}`);
        this.files.delete(path);
        if (this.isSyncEnabled) {
            this.enqueueSync(async () =>
                this.client.syncLocallyDeletedFile(path)
            );
        }
    }

    public async waitForSync(): Promise<void> {
        this.log("Waiting for sync to complete...");
        await withTimeout(
            this.client.waitUntilFinished(),
            WAIT_TIMEOUT_MS,
            `Client ${this.clientId} waitForSync timed out after ${WAIT_TIMEOUT_MS}ms`
        );
        this.log("Sync complete");
    }

    public async disableSync(): Promise<void> {
        this.log("Disabling sync");
        await this.client.setSetting("isSyncEnabled", false);
        this.isSyncEnabled = false;
    }

    public async enableSync(): Promise<void> {
        this.log("Enabling sync");
        await this.client.setSetting("isSyncEnabled", true);
        this.isSyncEnabled = true;
        await this.waitForWebSocket();
    }

    public async assertContent(
        path: string,
        expectedContent: string
    ): Promise<void> {
        this.log(`Asserting content of ${path} equals "${expectedContent}"`);
        const actualBytes = await this.read(path).catch(() => {
            throw new Error(
                `File ${path} does not exist on client ${this.clientId}`
            );
        });
        const actualContent = new TextDecoder().decode(actualBytes);
        assert(
            actualContent === expectedContent,
            `Content mismatch on client ${this.clientId} for ${path}:\nExpected: "${expectedContent}"\nActual: "${actualContent}"`
        );
        this.log(`✓ Content assertion passed for ${path}`);
    }

    public async assertExists(path: string): Promise<void> {
        this.log(`Asserting ${path} exists`);
        const exists = await this.exists(path);
        assert(
            exists,
            `File ${path} does not exist on client ${this.clientId}`
        );
        this.log(`✓ File ${path} exists`);
    }

    public async assertNotExists(path: string): Promise<void> {
        this.log(`Asserting ${path} does not exist`);
        const exists = await this.exists(path);
        assert(
            !exists,
            `File ${path} exists on client ${this.clientId} but should not`
        );
        this.log(`✓ File ${path} does not exist`);
    }

    public async getFiles(): Promise<RelativePath[]> {
        return this.listFilesRecursively();
    }

    public async getFileContent(path: string): Promise<string> {
        const bytes = await this.read(path);
        return new TextDecoder().decode(bytes);
    }

    public async cleanup(): Promise<void> {
        this.log("Cleaning up...");
        // Guard against uninitialized client (init() failed partway)
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (!this.client) {
            this.log("Client not initialized, nothing to clean up");
            return;
        }
        try {
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

    private enqueueSync(operation: () => Promise<void>): void {
        void this.executeSyncOperation(operation).catch((error) => {
            this.log(
                `Background sync failed (will retry on reconnect): ${error}`
            );
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
