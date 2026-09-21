import { removeFromArray } from "../remove-from-array";
import { awaitAll } from "../await-all";

/**
 * A utility class for managing event listeners with type-safe add/remove operations.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class EventListeners<TListener extends (...args: any[]) => any> {
    private readonly listeners: TListener[] = [];

    public constructor(
        private readonly onError: (error: unknown) => void = (error) => {
            console.error("Event observer failed", error);
        }
    ) {}

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
     * Observer failures are reported without interrupting delivery or background
     * work. Returned promises are observed; use triggerAsync() to await them.
     *
     * @param args The arguments to pass to each listener
     */
    public trigger(...args: Parameters<TListener>): void {
        for (const listener of [...this.listeners]) {
            try {
                void Promise.resolve(listener(...args)).catch(
                    (error: unknown) => {
                        this.reportFailure(error);
                    }
                );
            } catch (error) {
                this.reportFailure(error);
            }
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
        await awaitAll(
            this.listeners
                .map((listener) => {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
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
    private reportFailure(error: unknown): void {
        try {
            this.onError(error);
        } catch {
            // A diagnostic callback must not break background work either.
        }
    }
}
