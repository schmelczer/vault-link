import type { StoredDatabase, TextWithCursors } from "sync-client";
import type {
    RelativePath,
    FileSystemOperations,
    SyncSettings
} from "sync-client";
import { SyncClient } from "sync-client";
import { assert } from "./utils/assert";

/**
 * DeterministicAgent - A test agent that properly awaits all sync operations.
 *
 * Unlike MockClient which fires-and-forgets sync operations, this class
 * ensures each operation is fully registered with SyncClient before returning.
 */
export class DeterministicAgent implements FileSystemOperations {
    public readonly clientId: number;
    private readonly logger: (msg: string) => void;
    private readonly localFiles = new Map<string, Uint8Array>();
    private client!: SyncClient;
    private data: Partial<{
        settings: Partial<SyncSettings>;
        database: Partial<StoredDatabase>;
    }> = {};
    // Track sync state locally to avoid calling sync methods when disabled
    private isSyncEnabled = true;

    public constructor(
        clientId: number,
        initialSettings: Partial<SyncSettings>,
        logger: (msg: string) => void
    ) {
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

        // Verify connection is working
        const connectionCheck = await this.client.checkConnection();
        assert(
            connectionCheck.isSuccessful,
            `Client ${this.clientId} connection check failed`
        );
    }

    // FileSystemOperations implementation
    public async listFilesRecursively(
        _root?: RelativePath
    ): Promise<RelativePath[]> {
        return Array.from(this.localFiles.keys());
    }

    public async read(path: RelativePath): Promise<Uint8Array> {
        const file = this.localFiles.get(path);
        if (!file) {
            throw new Error(`File ${path} does not exist`);
        }
        return file;
    }

    public async getFileSize(path: RelativePath): Promise<number> {
        return (await this.read(path)).length;
    }

    public async exists(path: RelativePath): Promise<boolean> {
        return this.localFiles.has(path);
    }

    public async write(path: RelativePath, content: Uint8Array): Promise<void> {
        // This is called by SyncClient to write files received from the server.
        // Do NOT call sync methods here - that would create a feedback loop.
        this.localFiles.set(path, content);
    }

    public async createDirectory(_path: RelativePath): Promise<void> {
        // Virtual FS doesn't need directories
    }

    public async atomicUpdateText(
        path: RelativePath,
        updater: (currentContent: TextWithCursors) => TextWithCursors
    ): Promise<string> {
        // This is called by SyncClient (via FileOperations.write) during merge handling.
        // Do NOT call sync methods here - that would create a deadlock.
        const file = this.localFiles.get(path);
        if (!file) {
            throw new Error(`File ${path} does not exist`);
        }
        const currentContent = new TextDecoder().decode(file);
        const newContent = updater({ text: currentContent, cursors: [] }).text;
        this.localFiles.set(path, new TextEncoder().encode(newContent));
        return newContent;
    }

    public async delete(path: RelativePath): Promise<void> {
        // This is called by SyncClient to delete files.
        // Do NOT call sync methods here - that would create a feedback loop.
        this.localFiles.delete(path);
    }

    public async rename(
        oldPath: RelativePath,
        newPath: RelativePath
    ): Promise<void> {
        // This is called by SyncClient to rename files.
        // Do NOT call sync methods here - that would create a feedback loop.
        const file = this.localFiles.get(oldPath);
        if (!file) {
            throw new Error(`File ${oldPath} does not exist`);
        }
        this.localFiles.set(newPath, file);
        if (oldPath !== newPath) {
            this.localFiles.delete(oldPath);
        }
    }

    // Test operations
    public async createFile(path: string, content: string): Promise<void> {
        this.log(`Creating file ${path} with content: ${content}`);
        if (this.localFiles.has(path)) {
            throw new Error(`File ${path} already exists`);
        }
        const contentBytes = new TextEncoder().encode(content);
        this.localFiles.set(path, contentBytes);

        // Only sync if enabled - otherwise scheduleSyncForOfflineChanges will pick it up
        if (this.isSyncEnabled) {
            await this.client.syncLocallyCreatedFile(path);
        }
    }

    public async updateFile(path: string, content: string): Promise<void> {
        this.log(`Updating file ${path} with content: ${content}`);
        const contentBytes = new TextEncoder().encode(content);
        this.localFiles.set(path, contentBytes);

        // Only sync if enabled
        if (this.isSyncEnabled) {
            await this.client.syncLocallyUpdatedFile({ relativePath: path });
        }
    }

    public async renameFile(oldPath: string, newPath: string): Promise<void> {
        this.log(`Renaming file ${oldPath} to ${newPath}`);
        // Update local state
        const file = this.localFiles.get(oldPath);
        if (!file) {
            throw new Error(`File ${oldPath} does not exist`);
        }
        this.localFiles.set(newPath, file);
        if (oldPath !== newPath) {
            this.localFiles.delete(oldPath);
        }
        // Only sync if enabled
        if (this.isSyncEnabled) {
            await this.client.syncLocallyUpdatedFile({
                oldPath,
                relativePath: newPath
            });
        }
    }

    public async deleteFile(path: string): Promise<void> {
        this.log(`Deleting file ${path}`);
        // Update local state
        this.localFiles.delete(path);
        // Only sync if enabled
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
