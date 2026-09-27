// Replace the complete metadata value atomically.
export interface MetadataPersistenceProvider<T> {
    load: () => Promise<T | undefined>;
    save: (data: T) => Promise<void>;
}
