/** save() atomically replaces the entire value and resolves only after both the
 * data and its directory entry are durable across power loss. Failed saves must
 * leave either complete value readable; callers retain their recovery journal.
 */
export interface PersistenceProvider<T> {
    load: () => Promise<T | undefined>;
    save: (data: T) => Promise<void>;
}
