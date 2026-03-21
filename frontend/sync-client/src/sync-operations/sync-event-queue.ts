import type { Logger } from "../tracing/logger";
import type { VirtualFilesystem } from "../persistence/vfs";
import type { SyncEvent, CoalescedAction } from "./sync-events";
import { coalesce, eventToInitialAction } from "./sync-events";
import { SyncResetError } from "../errors/sync-reset-error";
import { EventListeners } from "../utils/data-structures/event-listeners";

// A document key is either a documentId (for tracked docs) or "path:<relativePath>" (for pending docs)
type DocumentKey = string;

export class SyncEventQueue {
    private readonly documentStates = new Map<DocumentKey, CoalescedAction>();
    private readonly processingOrder: DocumentKey[] = [];
    private currentlyProcessing: DocumentKey | null = null;
    private currentOperation: Promise<void> | null = null;
    private readonly idleWaiters: (() => void)[] = [];
    private isResetting = false;
    private isPaused = false;

    public readonly onRemainingOperationsCountChanged = new EventListeners<
        (count: number) => unknown
    >();

    // The executor is injected by the Syncer — it processes one CoalescedAction for one document
    private executor:
        | ((key: DocumentKey, action: CoalescedAction) => Promise<void>)
        | undefined;

    constructor(
        private readonly logger: Logger,
        private readonly vfs: VirtualFilesystem
    ) {}

    public setExecutor(
        executor: (key: DocumentKey, action: CoalescedAction) => Promise<void>
    ): void {
        this.executor = executor;
    }

    // --- Event ingestion ---

    public enqueue(event: SyncEvent): void {
        const key = this.resolveKey(event);
        const existing = this.documentStates.get(key);

        if (existing === undefined || existing.action === "noop") {
            this.documentStates.set(key, eventToInitialAction(event));
            this.addToProcessingOrder(key);
        } else {
            const newAction = coalesce(existing, event);
            if (newAction.action === "noop") {
                this.documentStates.delete(key);
                this.removeFromProcessingOrder(key);
            } else {
                this.documentStates.set(key, newAction);
                // If the key isn't in processingOrder (was being processed), add it back
                if (
                    !this.processingOrder.includes(key) &&
                    this.currentlyProcessing !== key
                ) {
                    this.addToProcessingOrder(key);
                }
            }
        }

        this.triggerCountChanged();
        this.processNext();
    }

    // --- Key migration ---

    public migrateKey(oldKey: DocumentKey, newDocumentId: string): void {
        const state = this.documentStates.get(oldKey);
        if (state === undefined) return;

        this.documentStates.delete(oldKey);
        this.removeFromProcessingOrder(oldKey);

        const existingNew = this.documentStates.get(newDocumentId);
        if (existingNew !== undefined) {
            // Merge: coalesce the old state into the new key's state.
            // This is unusual but can happen during key resolution races.
            // Keep the existing state at the new key (it's more recent).
        } else {
            this.documentStates.set(newDocumentId, state);
            this.addToProcessingOrder(newDocumentId);
        }
    }

    // --- Processing ---

    public hasOutstandingWork(): boolean {
        return this.documentStates.size > 0 || this.currentOperation !== null;
    }

    public hasPendingEventsFor(key: string): boolean {
        return (
            this.documentStates.has(key) ||
            this.documentStates.has("path:" + key) ||
            this.currentlyProcessing === key ||
            this.currentlyProcessing === "path:" + key
        );
    }

    public get pendingDocumentCount(): number {
        return (
            this.documentStates.size +
            (this.currentOperation !== null ? 1 : 0)
        );
    }

    public async waitForIdle(): Promise<void> {
        // When paused, consider the queue idle if no operation is running.
        // Queued events exist but are intentionally held until resume().
        if (this.currentOperation === null && (this.isPaused || this.documentStates.size === 0)) {
            return;
        }
        return new Promise<void>((resolve) => {
            this.idleWaiters.push(resolve);
        });
    }

    // --- Reset ---

    public reset(): void {
        this.isResetting = true;

        // Remove remote events (server will replay on reconnect).
        // Preserve local events (unsynced user actions).
        for (const [key, state] of this.documentStates.entries()) {
            if (
                state.action === "remote-update" ||
                state.action === "remote-delete"
            ) {
                this.documentStates.delete(key);
                this.removeFromProcessingOrder(key);
            }
        }

        this.idleWaiters.length = 0;
    }

    public clearResetting(): void {
        this.isResetting = false;
    }

    /** Pause processing. Events can still be enqueued but won't be executed. */
    public pause(): void {
        this.isPaused = true;
    }

    /** Resume processing. Immediately processes any queued events. */
    public resume(): void {
        this.isPaused = false;
        this.processNext();
    }

    public destroy(): void {
        this.documentStates.clear();
        this.processingOrder.length = 0;
        this.currentlyProcessing = null;
        this.idleWaiters.length = 0;
    }

    // --- Internal ---

    private resolveKey(event: SyncEvent): DocumentKey {
        switch (event.type) {
            case "remote-update":
            case "remote-delete":
                return event.version.documentId;
            case "local-create":
                return "path:" + event.path;
            case "local-update":
            case "local-delete": {
                const doc = this.vfs.getByPath(event.path);
                if (doc !== undefined && doc.state !== "pending") {
                    return doc.documentId;
                }
                return "path:" + event.path;
            }
            case "local-move": {
                const doc =
                    this.vfs.getByPath(event.toPath) ??
                    this.vfs.getByPath(event.fromPath);
                if (doc !== undefined && doc.state !== "pending") {
                    return doc.documentId;
                }
                return "path:" + event.fromPath;
            }
        }
    }

    private processNext(): void {
        if (this.currentOperation !== null) return;

        if (this.isPaused) {
            // Even when paused, resolve idle waiters since no operation is
            // running. This is needed because internalReconcile() pauses the
            // queue then calls waitForIdle() — if a previously-started
            // operation finishes while paused, idle waiters must be notified.
            if (this.idleWaiters.length > 0) {
                const waiters = this.idleWaiters.splice(0);
                for (const w of waiters) w();
            }
            return;
        }

        while (this.processingOrder.length > 0) {
            const key = this.processingOrder.shift()!;
            const action = this.documentStates.get(key);

            if (action === undefined || action.action === "noop") {
                this.documentStates.delete(key);
                continue;
            }

            this.currentlyProcessing = key;
            this.documentStates.delete(key);

            this.currentOperation = (async () => {
                try {
                    if (this.isResetting) throw new SyncResetError();
                    if (this.executor === undefined) {
                        throw new Error("No executor set");
                    }
                    await this.executor(key, action);
                } catch (e) {
                    if (!(e instanceof SyncResetError)) {
                        this.logger.info(
                            `Sync operation for ${key} failed, will retry: ${e}`
                        );
                    }
                } finally {
                    this.currentlyProcessing = null;
                    this.currentOperation = null;
                    this.triggerCountChanged();
                    this.processNext();
                }
            })();
            return; // processNext will be called again in finally
        }

        // Queue is empty, resolve idle waiters
        if (this.currentOperation === null) {
            const waiters = this.idleWaiters.splice(0);
            for (const w of waiters) w();
            this.triggerCountChanged();
        }
    }

    private addToProcessingOrder(key: DocumentKey): void {
        if (!this.processingOrder.includes(key)) {
            this.processingOrder.push(key);
        }
    }

    private removeFromProcessingOrder(key: DocumentKey): void {
        const idx = this.processingOrder.indexOf(key);
        if (idx !== -1) this.processingOrder.splice(idx, 1);
    }

    private triggerCountChanged(): void {
        this.onRemainingOperationsCountChanged.trigger(
            this.pendingDocumentCount
        );
    }
}
