import {
    SyncClient,
    LogLevel,
    type HistoryEntry,
    type SyncSettings
} from "sync-client";
import { MemoryDisk, MemoryPersistence } from "../../test-support/storage";
import { NetworkFaults, type RequestKind } from "../../test-support/network";
import { assert } from "./utils/assert";
import { sleep } from "./utils/sleep";
import { withTimeout } from "./utils/with-timeout";
import { WAIT_TIMEOUT_MS, WEBSOCKET_CONNECT_TIMEOUT_MS } from "./consts";
import { ManagedWebSocketFactory } from "./managed-websocket";

/** User actions live here; the engine only receives disk.session(). */
export class DeterministicAgent {
    public readonly disk = new MemoryDisk();
    public readonly persistence: MemoryPersistence;
    public readonly network = new NetworkFaults();
    private client?: SyncClient;
    private readonly errors: Error[] = [];
    private readonly pending = new Set<Promise<void>>();
    private readonly wsFactory = new ManagedWebSocketFactory();
    private nextWriteRename?: { oldPath: string; newPath: string };
    private delayedNotifications = false;
    private disposed = false;
    private readonly notifications: (() => Promise<void>)[] = [];

    public constructor(
        public readonly clientId: number,
        settings: Partial<SyncSettings>,
        private readonly logger: (msg: string) => void
    ) {
        this.persistence = new MemoryPersistence({
            settings: {
                networkRetryIntervalMs: 25,
                webSocketRetryIntervalMs: 50,
                requestTimeoutMs: 5_000,
                ...settings,
                // Scripted and seeded scenarios must exercise notification delivery.
                syncIntervalMs: 0
            }
        });
        this.disk.boundary = async (label) => {
            const rename = this.nextWriteRename;
            // Inject after the content write, before the metadata save.
            if (rename && label === `durable:write:${rename.oldPath}`) {
                this.nextWriteRename = undefined;
                await this.rename(rename.oldPath, rename.newPath);
            }
        };
    }

    public async init(
        fetchImplementation: typeof globalThis.fetch = fetch
    ): Promise<void> {
        this.client = await SyncClient.create({
            fs: this.disk.session(),
            persistence: this.persistence,
            fetch: this.network.wrap(fetchImplementation),
            webSocket: this.wsFactory.constructorFn
        });
        assert(
            this.client.getSettings().syncIntervalMs === 0,
            "Correctness scenarios must run with periodic polling disabled"
        );
        this.client.logger.onLogEmitted.add((line) => {
            this.logger(
                `[Client ${this.clientId}] ${line.level}: ${line.message}`
            );
            if (this.disposed && line.level === LogLevel.ERROR)
                throw new Error(
                    `Client ${this.clientId} error after cleanup: ${line.message}`
                );
            if (
                line.level === LogLevel.ERROR &&
                !this.isRetryableFailure(line.message)
            )
                this.errors.push(new Error(line.message));
        });
        await this.client.start();
        assert(
            (await this.client.checkConnection()).isSuccessful,
            `Client ${this.clientId} connection check failed`
        );
    }

    public database() {
        return this.persistence.snapshot().database;
    }
    public files(): Map<string, Uint8Array> {
        return this.disk.userFiles();
    }
    public async listFilesRecursively(): Promise<string[]> {
        return [...this.files().keys()].sort();
    }
    public async getFileContent(path: string): Promise<string> {
        const bytes = this.files().get(path);
        assert(bytes !== undefined, `Missing file: ${path}`);
        return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    }
    public async read(path: string): Promise<Uint8Array> {
        const snapshot = await this.disk.readSnapshot(path);
        assert(snapshot !== undefined, `Missing file: ${path}`);
        return snapshot.content;
    }
    public async write(path: string, content: Uint8Array): Promise<void> {
        const created = !(await this.disk.exists(path));
        await this.disk.userWrite(path, content);
        this.notify(() =>
            created
                ? this.client!.syncLocallyCreatedFile(path)
                : this.client!.syncLocallyUpdatedFile({ relativePath: path })
        );
    }
    public async rename(oldPath: string, relativePath: string): Promise<void> {
        await this.disk.userRename(oldPath, relativePath);
        this.notify(() =>
            this.client!.syncLocallyUpdatedFile({ oldPath, relativePath })
        );
    }
    public async delete(path: string): Promise<void> {
        await this.disk.userDelete(path);
        this.notify(() => this.client!.syncLocallyDeletedFile(path));
    }
    public delayNotifications(): void {
        this.delayedNotifications = true;
    }
    public flushNotifications(): void {
        this.delayedNotifications = false;
        for (const notify of this.notifications.splice(0)) this.enqueue(notify);
    }
    private notify(operation: () => Promise<void>): void {
        // Offline means transport disabled, not that editor identity events vanish.
        if (this.delayedNotifications) this.notifications.push(operation);
        else this.enqueue(operation);
    }
    private enqueue(operation: () => Promise<void>): void {
        const promise = operation().catch((error: unknown) => {
            if (!this.isRetryableFailure(String(error)))
                this.errors.push(
                    error instanceof Error ? error : new Error(String(error))
                );
        });
        this.pending.add(promise);
        void promise.then(() => this.pending.delete(promise));
    }
    private async drain(): Promise<void> {
        while (this.pending.size) await Promise.all([...this.pending]);
    }
    private isRetryableFailure(message: string): boolean {
        // A coherent scan rejecting an editor race is a required adapter
        // behavior. It must subsequently converge; never blanket-ignore errors.
        return (
            this.network.isExpectedFailure(message) ||
            /^(Sync paused for retry: )?Error: File changed during scan: .+$/.test(
                message
            )
        );
    }
    private assertHealthy(): void {
        if (this.errors.length) {
            const errors = this.errors.splice(0);
            throw new AggregateError(
                errors,
                `Client ${this.clientId}: ${errors.map(String).join("; ")}`
            );
        }
    }
    public async waitForSync(): Promise<void> {
        assert(
            this.client!.getSettings().syncIntervalMs === 0,
            "Periodic polling was enabled during a correctness scenario"
        );
        await withTimeout(
            (async () => {
                await this.drain();
                const deadline = Date.now() + WAIT_TIMEOUT_MS;
                for (;;) {
                    try {
                        await this.client!.waitUntilFinished();
                        break;
                    } catch (error) {
                        if (
                            !this.isRetryableFailure(String(error)) ||
                            Date.now() >= deadline
                        )
                            throw error;
                        await sleep(30);
                    }
                }
                this.assertHealthy();
            })(),
            WAIT_TIMEOUT_MS,
            `Client ${this.clientId} sync timeout`
        );
    }
    public async disableSync(): Promise<void> {
        await this.drain();
        await this.client!.setSetting("isSyncEnabled", false);
        this.assertHealthy();
    }
    public async enableSync(wait = true): Promise<void> {
        // setSetting waits for a sync attempt in v4. Track it, but don't block
        // the script from resuming a paused server or releasing a checkpoint.
        this.enqueue(() => this.client!.setSetting("isSyncEnabled", true));
        const deadline = Date.now() + WEBSOCKET_CONNECT_TIMEOUT_MS;
        while (
            !this.persistence.snapshot().settings?.isSyncEnabled &&
            Date.now() < deadline
        )
            await sleep(1);
        assert(
            !!this.persistence.snapshot().settings?.isSyncEnabled,
            "Enable did not persist"
        );
        if (wait) await this.waitForSync();
    }
    public async reset(): Promise<void> {
        await this.drain();
        await this.client!.reset();
    }
    public pauseWebSocket(): void {
        this.wsFactory.pause();
    }
    public pauseObservation(): void {
        this.pauseWebSocket();
        this.network.pauseObservation();
    }
    public resumeObservation(): void {
        this.network.resumeObservation();
        this.resumeWebSocket();
    }
    public async waitForObservation(): Promise<void> {
        await withTimeout(
            this.network.waitForObservation(),
            WAIT_TIMEOUT_MS,
            "HTTP observation checkpoint never reached"
        );
    }
    public resumeWebSocket(): void {
        this.wsFactory.resume();
    }
    public dropNextCreateResponse(): void {
        this.network.arm("create");
    }
    public dropNextResponse(
        kind: RequestKind,
        point: "before" | "after" = "after"
    ): void {
        this.network.arm(kind, point);
    }
    public async waitForDroppedCreateResponse(): Promise<void> {
        await withTimeout(
            this.network.wait(),
            WAIT_TIMEOUT_MS,
            "Armed response drop never fired"
        );
    }
    public renameNextWrite(oldPath: string, newPath: string): void {
        assert(
            !this.nextWriteRename,
            "Previous install/rename hook never fired"
        );
        this.nextWriteRename = { oldPath, newPath };
    }
    public async waitForHistoryEntry(
        matches: (entry: HistoryEntry) => boolean,
        onMatch?: (entry: HistoryEntry) => void
    ): Promise<void> {
        let unsubscribe = () => {};
        try {
            await withTimeout(
                new Promise<void>((resolve) => {
                    const check = () => {
                        const entry =
                            this.client!.getHistoryEntries().find(matches);
                        if (entry) {
                            onMatch?.(entry);
                            resolve();
                        }
                    };
                    unsubscribe = this.client!.onSyncHistoryUpdated.add(check);
                    check();
                }),
                WAIT_TIMEOUT_MS,
                "History checkpoint not reached"
            );
        } finally {
            unsubscribe();
        }
    }
    public async cleanup(): Promise<void> {
        if (!this.client) return;
        const errors: unknown[] = [];
        this.resumeObservation();
        this.flushNotifications();
        try {
            await this.waitForSync();
        } catch (error) {
            errors.push(error);
        }
        try {
            this.network.assertConsumed();
            assert(!this.nextWriteRename, "Install/rename hook never fired");
        } catch (error) {
            errors.push(error);
        }
        try {
            await withTimeout(
                this.client.destroy(),
                WAIT_TIMEOUT_MS,
                "Destroy timed out"
            );
            await withTimeout(
                this.wsFactory.finish(),
                WAIT_TIMEOUT_MS,
                "WebSocket callbacks did not finish during cleanup"
            );
        } catch (error) {
            errors.push(error);
        }
        this.client = undefined;
        this.disposed = true;
        try {
            this.assertHealthy();
        } catch (error) {
            errors.push(error);
        }
        if (errors.length)
            throw new AggregateError(
                errors,
                `Client ${this.clientId} cleanup failed: ${errors.map(String).join("; ")}`
            );
    }
}
