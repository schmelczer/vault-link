import { SyncResetError } from "../../errors/sync-reset-error";
import type { Logger } from "../../tracing/logger";

/**
 * Manages exclusive locks on items to prevent concurrent modifications.
 * Locks are granted in FIFO order.
 *
 * @template T The type of the key used for locking
 */
/** Waiter entry with callbacks */
interface WaiterEntry<T> {
    resolve: () => unknown;
    reject: (err: unknown) => unknown;
}

export class Locks<T> {
    /** Currently locked keys */
    private readonly locked = new Set<T>();

    /** Queue of waiters for each key */
    private readonly waiters = new Map<T, WaiterEntry<T>[]>();

    public constructor(private readonly name: string, private readonly logger?: Logger) { }

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

        const lockedKeys = [];
        try {
            for (const key of uniqueKeys) {
                // Must acquire locks in-order (not concurrently) to prevent deadlocks
                await this.waitForLock(key);
                lockedKeys.push(key);
            }

            return await fn();
        } finally {
            lockedKeys.forEach((key) => {
                this.unlock(key);
            });
        }
    }

    public reset(): void {
        // Resolve all waiting promises before clearing to prevent deadlock
        // Any operation waiting for a lock will be granted access immediately
        for (const waiting of this.waiters.values()) {
            for (const { reject } of waiting) {
                reject(new SyncResetError());
            }
        }

        // Do NOT clear this.locked — let running operations release their own
        // locks via the finally block in withLock. Clearing this.locked would
        // allow new operations to acquire locks on keys still held by in-flight
        // operations, breaking mutual exclusion.
        this.waiters.clear();
    }

    public isLocked(key: T): boolean {
        return this.locked.has(key);
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

        this.logger?.debug(`Waiting for lock '${this.name}' on '${key}'`);

        return new Promise((resolve, reject) => {
            // DefaultDict behavior
            let waiting = this.waiters.get(key);
            if (!waiting) {
                waiting = [];
                this.waiters.set(key, waiting);
            }

            waiting.push({
                resolve,
                reject,
            });
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
            this.logger?.debug(
                `Attempted to unlock '${this.name}' on '${key}' which is not locked`
            );
            return;
        }

        this.logger?.debug(`Releasing lock '${this.name}' on '${key}'`);

        // Remove first waiter to ensure FIFO order
        const nextWaiter = this.waiters.get(key)?.shift();

        if (nextWaiter) {
            this.logger?.debug(`Granted lock '${this.name}' on '${key}'`);
            nextWaiter.resolve();
        } else {
            this.locked.delete(key);
        }
    }
}

export class Lock {
    private readonly locks: Locks<boolean>;

    public constructor(name: string, logger?: Logger) {
        this.locks = new Locks(name, logger);
    }

    public async withLock<R>(fn: () => R | Promise<R>): Promise<R> {
        return this.locks.withLock(true, fn);
    }

    public reset(): void {
        this.locks.reset();
    }
}
