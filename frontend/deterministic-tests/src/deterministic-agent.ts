import type { StoredDatabase, SyncSettings, RelativePath } from "sync-client";
import { SyncClient, debugging } from "sync-client";
import { assert } from "./utils/assert";

export class DeterministicAgent extends debugging.InMemoryFileSystem {
    public readonly clientId: number;
    private readonly logger: (msg: string) => void;
    private client!: SyncClient;
    private data: Partial<{
        settings: Partial<SyncSettings>;
        database: Partial<StoredDatabase>;
    }> = {};
    private isSyncEnabled = true;

    public constructor(
        clientId: number,
        initialSettings: Partial<SyncSettings>,
        logger: (msg: string) => void
    ) {
        super();
        this.clientId = clientId;
        this.logger = logger;
        this.data.settings = initialSettings;
        this.isSyncEnabled = initialSettings.isSyncEnabled !== false;
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

        const connectionCheck = await this.client.checkConnection();
        assert(
            connectionCheck.isSuccessful,
            `Client ${this.clientId} connection check failed`
        );
    }

    public async createFile(path: string, content: string): Promise<void> {
        this.log(`Creating file ${path} with content: ${content}`);
        if (this.files.has(path)) {
            throw new Error(`File ${path} already exists`);
        }
        const contentBytes = new TextEncoder().encode(content);
        this.files.set(path, contentBytes);

        if (this.isSyncEnabled) {
            await this.client.syncLocallyCreatedFile(path);
        }
    }

    public async updateFile(path: string, content: string): Promise<void> {
        this.log(`Updating file ${path} with content: ${content}`);
        const contentBytes = new TextEncoder().encode(content);
        this.files.set(path, contentBytes);

        if (this.isSyncEnabled) {
            await this.client.syncLocallyUpdatedFile({ relativePath: path });
        }
    }

    public async renameFile(oldPath: string, newPath: string): Promise<void> {
        this.log(`Renaming file ${oldPath} to ${newPath}`);
        const file = this.files.get(oldPath);
        if (!file) {
            throw new Error(`File ${oldPath} does not exist`);
        }
        this.files.set(newPath, file);
        if (oldPath !== newPath) {
            this.files.delete(oldPath);
        }
        if (this.isSyncEnabled) {
            await this.client.syncLocallyUpdatedFile({
                oldPath,
                relativePath: newPath
            });
        }
    }

    public async deleteFile(path: string): Promise<void> {
        this.log(`Deleting file ${path}`);
        this.files.delete(path);
        if (this.isSyncEnabled) {
            await this.client.syncLocallyDeletedFile(path);
        }
    }

    public async waitForSync(): Promise<void> {
        this.log("Waiting for sync to complete...");
        await this.client.waitUntilFinished();
        this.log("Sync complete");
    }

    public async disableSync(): Promise<void> {
        this.log("Disabling sync");
        this.isSyncEnabled = false;
        await this.client.setSetting("isSyncEnabled", false);
    }

    public async enableSync(): Promise<void> {
        this.log("Enabling sync");
        this.isSyncEnabled = true;
        await this.client.setSetting("isSyncEnabled", true);
    }

    public async assertContent(
        path: string,
        expectedContent: string
    ): Promise<void> {
        this.log(`Asserting content of ${path} equals "${expectedContent}"`);
        const exists = await this.exists(path);
        assert(
            exists,
            `File ${path} does not exist on client ${this.clientId}`
        );

        const actualBytes = await this.read(path);
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
        await this.client.waitUntilFinished();
        await this.client.destroy();
        this.log("Cleanup complete");
    }

    private log(message: string): void {
        this.logger(`[Client ${this.clientId}] ${message}`);
    }
}
