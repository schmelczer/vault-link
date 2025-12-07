import { removeFromArray } from "../remove-from-array";
import { awaitAll } from "../await-all";

/**
* A utility class for managing event listeners with type-safe add/remove operations.
*/
export class EventListeners<TListener extends (...args: any[]) => any> {
    private readonly listeners: TListener[] = [];

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
        this.listeners.forEach((listener) => {
            listener(...args);
        });
    }

    /**
    * Triggers all listeners and awaits any promises they return.
    * Synchronous listeners are called immediately, and any async listeners
    * are awaited in parallel.
    *
    * @param args The arguments to pass to each listener
    */
    public async triggerAsync(...args: Parameters<TListener>): Promise<void> {
        await awaitAll(
            this.listeners
                .map((listener) => {
                    return listener(...args);
                })
                .filter((result): result is Promise<unknown> => {
                    return result instanceof Promise;
                })
        );
    }

    public clear(): void {
        this.listeners.length = 0;
    }

    public get count(): number {
        return this.listeners.length;
    }


}
