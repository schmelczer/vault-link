import type { StoredClient } from "../sync-client";
import type { StoredDatabase } from "./database";
import type { MetadataPersistenceProvider } from "./metadata-persistence-provider";
import { Lock } from "../utils/data-structures/locks";

// Serialize partial updates to the shared settings, database and notification store
export class ClientMetadataStore {
    private readonly lock = new Lock();
    private reloadBeforeSave = false;

    private constructor(
        public stored: StoredClient,
        private readonly persistence: MetadataPersistenceProvider<StoredClient>
    ) { }

    public static async load(
        persistence: MetadataPersistenceProvider<StoredClient>
    ): Promise<ClientMetadataStore> {
        return new ClientMetadataStore(
            (await persistence.load()) ?? {},
            persistence
        );
    }

    public async save(update: StoredClient): Promise<void> {
        await this.lock.withLock(async () => {
            if (this.reloadBeforeSave) {
                await this.reload();
            }

            const next = { ...this.stored, ...structuredClone(update) };
            try {
                await this.persistence.save(next);
                this.stored = next;
            } catch (error) {
                // A failed save may have committed. Reload before another update
                // so settings or notifications cannot roll the database back.
                this.reloadBeforeSave = true;
                throw error;
            }
        });
    }

    public async reloadDatabase(): Promise<StoredDatabase | undefined> {
        return this.lock.withLock(async () => {
            await this.reload();
            return this.stored.database;
        });
    }

    private async reload(): Promise<void> {
        this.stored = (await this.persistence.load()) ?? {};
        this.reloadBeforeSave = false;
    }
}
