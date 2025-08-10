import type { Logger } from "../tracing/logger";

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
	private readonly waiters = new Map<T, (() => unknown)[]>();

	public constructor(private readonly logger: Logger) {}

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

		this.logger.debug(`Waiting for lock on ${key}`);

		return new Promise((resolve) => {
			// DefaultDict behavior
			let waiting = this.waiters.get(key);
			if (!waiting) {
				waiting = [];
				this.waiters.set(key, waiting);
			}

			waiting.push(resolve);
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
			throw new Error(`Key ${key} is not locked, cannot unlock`);
		}

		// Remove first waiter to ensure FIFO order
		const nextWaiting = this.waiters.get(key)?.shift();

		if (nextWaiting) {
			this.logger.debug(`Granted lock on ${key}`);
			nextWaiting();
		} else {
			this.locked.delete(key);
		}
	}

	/**
	 * Clears all locks and waiters. Causes waiting operations to hang indefinitely.
	 * Use with caution.
	 */
	public reset(): void {
		this.locked.clear();
		this.waiters.clear();
	}
}
