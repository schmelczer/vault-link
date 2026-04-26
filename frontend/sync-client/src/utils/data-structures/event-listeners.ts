import { removeFromArray } from "../remove-from-array";
import { awaitAll } from "../await-all";

/**
 * A utility class for managing event listeners with type-safe add/remove operations.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class EventListeners<TListener extends (...args: any[]) => any> {
    private readonly listeners: TListener[] = [];

    public get count(): number {
        return this.listeners.length;
    }

    /**
     * Adds a new listener to the collection.
     *
     * @param listener The listener callback to add
     * @returns An unsubscribe function that removes this listener when called
     */
    public add(listener: TListener): () => void {
        this.listeners.push(listener);
        return () => this.remove(listener);
    }

    /**
     * Removes a listener from the collection.
     *
     * @param listener The listener callback to remove
     * @returns true if the listener was found and removed, false otherwise
     */
    public remove(listener: TListener): boolean {
        return removeFromArray(this.listeners, listener);
    }

    /**
     * Triggers all listeners synchronously with the provided arguments.
     * Any returned promises are ignored. Use triggerAsync() to await them.
     *
     * @param args The arguments to pass to each listener
     */
    public trigger(...args: Parameters<TListener>): void {
        const snapshot = this.listeners.slice();
        for (const listener of snapshot) {
            // allow removing listeners during the trigger loop
            if (!this.listeners.includes(listener)) {continue;}
            listener(...args);
        }
    }

    /**
     * Triggers all listeners and awaits any promises they return.
     * Synchronous listeners are called immediately, and any async listeners
     * are awaited in parallel.
     *
     * @param args The arguments to pass to each listener
     */
    public async triggerAsync(...args: Parameters<TListener>): Promise<void> {
        const snapshot = this.listeners.slice();
        const promises: Promise<unknown>[] = [];
        for (const listener of snapshot) {
            if (!this.listeners.includes(listener)) {continue;}
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            const result = listener(...args);
            if (result instanceof Promise) {
                promises.push(result);
            }
        }
        await awaitAll(promises);
    }

    public clear(): void {
        this.listeners.length = 0;
    }
}
