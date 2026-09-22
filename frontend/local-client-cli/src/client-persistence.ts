import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type {
    PersistenceProvider,
    StoredClient,
    StoredDatabase,
    SyncSettings
} from "sync-client";

/** Only client metadata needs an atomic replacement; user files do not. */
export class ClientPersistence implements PersistenceProvider<StoredClient> {
    public constructor(
        private readonly file: string,
        private readonly settings: Partial<SyncSettings>
    ) {}

    public async load(): Promise<StoredClient> {
        const content = await fs
            .readFile(this.file, "utf8")
            .catch((error: unknown) => {
                if (
                    error instanceof Error &&
                    "code" in error &&
                    error.code === "ENOENT"
                )
                    return undefined;
                throw error;
            });
        if (content === undefined) return { settings: this.settings };
        const parsed: unknown = JSON.parse(content);
        if (
            parsed === null ||
            typeof parsed !== "object" ||
            Array.isArray(parsed)
        )
            throw new Error("Invalid client metadata");
        // The sync engine validates and migrates the persisted fields.
        const data = parsed as StoredClient & Partial<StoredDatabase>;
        // Earlier CLI versions saved the database alone.
        const stored: StoredClient =
            "fileManifest" in data ? { database: data } : data;
        return {
            ...stored,
            settings: { ...stored.settings, ...this.settings }
        };
    }

    public async save(data: StoredClient): Promise<void> {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${randomUUID()}.tmp`;
        try {
            const handle = await fs.open(temporary, "wx", 0o600);
            try {
                await handle.writeFile(JSON.stringify(data));
                // Flush the complete value before exposing its name. A crash can
                // keep the previous value, but must not expose truncated JSON.
                await handle.sync();
            } finally {
                await handle.close();
            }
            await fs.rename(temporary, this.file);
        } finally {
            await fs.rm(temporary, { force: true });
        }
    }
}
