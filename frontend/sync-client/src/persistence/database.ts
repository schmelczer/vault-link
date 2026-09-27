import type { PendingRequest } from "./requests";
import type { FileManifest } from "../services/types/FileManifest";
import type { FileManifestEntries } from "../types/file-manifest-entries";

export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface ContentHead {
    vaultUpdateId: VaultUpdateId;
    contentSize: number;
}

export interface DocumentState {
    // A null version retains only the clean hash after a server history reset.
    base?: { vaultUpdateId: VaultUpdateId | null; hash: string };

    // Last observed disk hash; an empty string means a notification awaits scanning.
    observedHash?: string;

    // A remote version still to be incorporated, including excluded downloads.
    remote?: ContentHead;
}

export type { PendingRequest } from "./requests";

export interface StoredDatabase {
    readonly vaultKey: string;

    // Last incorporated server manifest; the base for the next three-way path merge.
    parentFileManifest: FileManifest;

    // Current local document IDs and paths, including files awaiting upload or download.
    actualFileManifest: FileManifestEntries;

    // Per-document merge bases and observations; content bytes are not stored here.
    documents: Record<DocumentId, DocumentState>;

    // Absent until a vault snapshot is applied; also marks a durable history reset.
    lastSeenUpdateId?: VaultUpdateId;

    // Exact request to resolve before observing a newer remote base.
    pending?: PendingRequest;

    // Commits consumption of the saved notification queue with the identity map.
    lastAppliedLocalChangeId?: string;

    // Server path at the start of exclusion, retained as the path-merge base.
    // null means the document was absent from the server manifest at that time.
    excluded?: Record<DocumentId, RelativePath | null>;
}

export function createEmptyDatabase(vaultKey: string): StoredDatabase {
    return {
        vaultKey,
        parentFileManifest: { fileManifestId: 0, entries: {} },
        actualFileManifest: {},
        documents: {}
    };
}

function canBindToAnotherVault(state: StoredDatabase): boolean {
    return (
        state.lastSeenUpdateId === undefined &&
        !state.pending &&
        Object.keys(state.actualFileManifest).length === 0
    );
}

export class Database {
    public state: StoredDatabase;
    private needsReload = false;

    public constructor(
        initial: StoredDatabase | undefined,
        vaultKey: string,
        private readonly saveData: (data: StoredDatabase) => Promise<void>,
        private readonly loadData: () => Promise<StoredDatabase | undefined>
    ) {
        const state =
            initial === undefined
                ? createEmptyDatabase(vaultKey)
                : structuredClone(initial);

        if (state.vaultKey !== vaultKey && !canBindToAnotherVault(state)) {
            throw new Error(
                "Incompatible vault identity. Preserve it for recovery and initialize a separate state store."
            );
        }

        this.state = { ...state, vaultKey };
    }

    public get length(): number {
        return Object.keys(this.state.actualFileManifest).length;
    }

    // Bind an empty database to the configured vault.
    public async bindVault(vaultKey: string): Promise<void> {
        if (this.state.vaultKey === vaultKey) {
            return;
        }

        if (!canBindToAnotherVault(this.state)) {
            throw new Error(
                "Incompatible vault identity. Preserve it for recovery and initialize a separate state store."
            );
        }

        await this.commit({ ...this.state, vaultKey });
    }

    public async commit(next: StoredDatabase): Promise<void> {
        const snapshot = structuredClone(next);

        if (this.needsReload) {
            throw new Error(
                "Reload saved state before retrying an uncertain save"
            );
        }

        this.needsReload = true;
        await this.saveData(snapshot);
        this.state = snapshot;
        this.needsReload = false;
    }

    public findDocumentId(path: RelativePath): DocumentId | undefined {
        return Object.keys(this.state.actualFileManifest).find(
            (id) => this.state.actualFileManifest[id] === path
        );
    }

    public async reloadFromSave(): Promise<void> {
        if (!this.needsReload) {
            return;
        }

        const saved = await this.loadData();
        if (saved) {
            this.state = structuredClone(saved);
        }

        this.needsReload = false;
    }

    public cloneState(): StoredDatabase {
        return structuredClone(this.state);
    }

    public async save(): Promise<void> {
        await this.commit(this.state);
    }


}
