/** Replace the complete metadata value atomically. Interrupted or failed saves
 * must leave an old/new complete value (or no value for the first save), never
 * partially parsed state. No ordering or durability of user files is required.
 */
export interface PersistenceProvider<T> {
    load: () => Promise<T | undefined>;
    save: (data: T) => Promise<void>;
}
