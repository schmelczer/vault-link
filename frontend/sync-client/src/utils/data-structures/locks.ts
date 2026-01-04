import { SyncResetError } from "../../errors/sync-reset-error";
import type { Logger } from "../../tracing/logger";
import { awaitAll } from "../await-all";

/**
 * Manages exclusive locks on items to prevent concurrent modifications.
 * Locks are granted in FIFO order.
 *
 * @template T The type of the key used for locking
 */
export class Locks<T> {
    /** Currently locked keys */
    private readonly locked = new Set<T>();

    /** Queue of resolve functions waiting for each key */
    private readonly waiters = new Map<
        T,
        [() => unknown, (err: unknown) => unknown][]
    >();

    public constructor(private readonly logger?: Logger) {}

    /**
     * Executes a function while holding exclusive locks on one or more keys.
     *
     * This method ensures that the provided function runs with exclusive access to the
     * specified key(s). Multiple keys are sorted to prevent deadlocks when different
     * operations request the same keys in different orders.
     *
     * @template R The return type of the function to execute
     * @param keyOrKeys A single key or array of keys to lock during function execution
     * @param fn The function to execute while holding the lock(s). Can be sync or async.
     * @returns A Promise that resolves to the return value of the executed function
     *
     * @example
     * ```typescript
     * // Lock a single key
     * const result = await locks.withLock('file1', () => {
     *   // Critical section - only one operation can access 'file1' at a time
     *   return processFile('file1');
     * });
     *
     * // Lock multiple keys (prevents deadlocks through consistent ordering)
     * await locks.withLock(['file1', 'file2'], async () => {
     *   // Critical section - exclusive access to both files
     *   await moveFile('file1', 'file2');
     * });
     * ```
     *
     * @throws Any error thrown by the provided function will be propagated after locks are released
     */
    public async withLock<R>(
        keyOrKeys: T | T[],
        fn: () => R | Promise<R>
    ): Promise<R> {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];

        // Deduplicate keys to prevent deadlock from acquiring same lock twice
        const uniqueKeys = Array.from(new Set(keys));
        uniqueKeys.sort((a, b) => String(a).localeCompare(String(b))); // Ensure consistent order to prevent deadlocks

        await awaitAll(uniqueKeys.map(async (key) => this.waitForLock(key)));

        try {
            return await fn();
        } finally {
            uniqueKeys.forEach((key) => {
                this.unlock(key);
            });
        }
    }

    public reset(): void {
        // Resolve all waiting promises before clearing to prevent deadlock
        // Any operation waiting for a lock will be granted access immediately
        for (const waiting of this.waiters.values()) {
            for (const [_, reject] of waiting) {
                reject(new SyncResetError());
            }
        }
        this.locked.clear();
        this.waiters.clear();
    }

    /**
     * Attempts to acquire a lock immediately without waiting.
     * Must call `unlock()` if successful.
     *
     * @param key The key to lock
     * @returns `true` if lock acquired, `false` if already locked
     */
    public tryLock(key: T): boolean {
        if (this.locked.has(key)) {
            return false;
        }

        this.locked.add(key);

        return true;
    }

    /**
     * Waits to acquire a lock, blocking until available.
     * Operations are queued in FIFO order. Must call `unlock()` when done.
     *
     * @param key The key to wait for and lock
     * @returns Promise that resolves when lock is acquired
     */
    public async waitForLock(key: T): Promise<void> {
        if (this.tryLock(key)) {
            return Promise.resolve();
        }

        this.logger?.debug(`Waiting for lock on ${key}`);

        return new Promise((resolve, reject) => {
            // DefaultDict behavior
            let waiting = this.waiters.get(key);
            if (!waiting) {
                waiting = [];
                this.waiters.set(key, waiting);
            }

            waiting.push([resolve, reject]);
        });
    }

    /**
     * Releases a lock and grants access to the next waiting operation in FIFO order.
     * Removes the key from locked set if no waiters.
     *
     * @param key The key to unlock
     * @throws {Error} If key is not currently locked
     */
    public unlock(key: T): void {
        if (!this.locked.has(key)) {
            return;
        }

        // Remove first waiter to ensure FIFO order
        const [resolveNextWaiting, _] = this.waiters.get(key)?.shift() ?? [];

        if (resolveNextWaiting) {
            this.logger?.debug(`Granted lock on ${key}`);
            resolveNextWaiting();
        } else {
            this.locked.delete(key);
        }
    }
}

export class Lock {
    private readonly locks: Locks<boolean>;

    public constructor(logger?: Logger) {
        this.locks = new Locks(logger);
    }

    public async withLock<R>(fn: () => R | Promise<R>): Promise<R> {
        return this.locks.withLock(true, fn);
    }

    public reset(): void {
        this.locks.reset();
    }
}
