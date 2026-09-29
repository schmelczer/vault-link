import type { StoredDatabase } from "./database";
import type { SyncSettings } from "./settings";
import type { LocalChange } from "../sync-operations/local-changes";

export type StoredClient = Partial<{
    settings: Partial<SyncSettings>;
    database: StoredDatabase;
    localChanges: LocalChange[];
    localChangesVaultKey: string;
    historyCheckpoint: { vaultKey: string; checkpoint?: string };
}>;

// Replace the complete metadata value atomically.
export interface MetadataPersistenceProvider {
    load: () => Promise<StoredClient | undefined>;
    save: (data: StoredClient) => Promise<void>;
}
