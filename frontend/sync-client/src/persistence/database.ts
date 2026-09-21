import type { CursorPosition } from "reconcile-text";
import type { Logger } from "../tracing/logger";
import type { DocumentUpdateResponse } from "../services/types/DocumentUpdateResponse";
import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";
import type { FileManifest } from "../services/types/FileManifest";
import type { FileManifestUpdateResponse } from "../services/types/FileManifestUpdateResponse";
import type { PushFileManifest } from "../services/types/PushFileManifest";
import type { PutFileContent } from "../services/types/PutFileContent";
import type { VaultSnapshot } from "../services/types/VaultSnapshot";
import type { EventRecord } from "../services/types/EventRecord";
import type { FileManifestEntries } from "../types/file-manifest-entries";

export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface StoredSnapshot {
    contentBase64: string;
    hash: string;
    cursors?: CursorPosition[];
}

export interface DocumentMetadata {
    parentVersionId: number;
    hash: string;
    remoteRelativePath?: string;
}

export interface DocumentState {
    /** Local clean base retained while rebasing after a server restore. */
    recoveryBase?: StoredSnapshot;
    base?: DocumentVersionWithoutContent & { hash: string };
    observedHash?: string;
    materialized: boolean;
    /** First contact with existing local content: there is no common ancestor. */
    bootstrap?: boolean;
    /** Do not resubmit an unchanged payload rejected by the server. */
    rejected?: { hash: string; message: string };
}

export type PendingRequest = { rejection?: string } & (
    | {
          type: "content";
          documentId: string;
          request: PutFileContent;
          snapshot: StoredSnapshot;
          response?: DocumentUpdateResponse;
      }
    | {
          type: "fileManifest";
          request: PushFileManifest;
          response?: FileManifestUpdateResponse;
      }
);

export interface EngineState {
    /** Durable reset intent; clear the transport checkpoint before bootstrap. */
    historyRecovery?: boolean;
    vaultKey: string;
    initialized: boolean;
    fileManifest: FileManifest;
    local: FileManifestEntries;
    documents: Record<string, DocumentState>;
    lastSeenUpdateId: number;
    remoteHeads: Record<string, DocumentVersionWithoutContent>;
    bootstrap?: VaultSnapshot;
    /** Fold pages durably without applying intermediate remote snapshots. */
    eventReplay?: {
        after: number;
        manifest: FileManifest;
        heads: Record<string, DocumentVersionWithoutContent>;
        receipts: EventRecord[];
    };
    pending?: PendingRequest;
    /** A rejected retry does not prove an earlier attempt failed to commit. */
    unconfirmed?: PendingRequest[];
    /** Commits consumption of the durable notification queue with the identity map. */
    lastAppliedLocalChangeId?: string;
    /** Physical exclusions, including files with no sync identity. */
    protectedPaths?: string[];
    /** Original server paths while local files are excluded; null means absent. */
    excluded?: Record<string, string | null>;
    rejectedManifest?: { entries: FileManifestEntries; message: string };
}

export interface FileStep {
    documentId: string;
    from?: string;
    to?: string;
    expected?: StoredSnapshot;
    replacement?: StoredSnapshot;
    staged: string;
    output: string;
    /** A permanent destination error has already selected a root fallback. */
    replanned?: boolean;
    /** Retained input of a later step for this identity; never projected as live. */
    superseded?: boolean;
    phase: "planned" | "staged" | "prepared" | "installing" | "installed";
}

export interface ApplicationJournal {
    id: string;
    extensions: string[];
    next: EngineState;
    steps: FileStep[];
}

export interface StoredDatabase extends EngineState {
    application?: ApplicationJournal;
}

// Read-only view used by cursor tracking and status reporting.
export interface DocumentRecord {
    documentId: string;
    relativePath: string;
    metadata?: DocumentMetadata;
    isDeleted: boolean;
}

export function emptyState(vaultKey: string): StoredDatabase {
    return {
        vaultKey,
        initialized: false,
        fileManifest: { fileManifestId: 0, entries: {} },
        local: {},
        documents: {},
        remoteHeads: {},
        lastSeenUpdateId: 0
    };
}

function canRebindEmpty(state: Partial<StoredDatabase> | undefined): boolean {
    return (
        state !== undefined &&
        !state.initialized &&
        !state.pending &&
        !state.application &&
        !state.bootstrap &&
        !state.eventReplay &&
        (state.unconfirmed?.length ?? 0) === 0 &&
        Object.keys(state.local ?? {}).length === 0
    );
}

export class Database {
    public state: StoredDatabase;
    private needsReload = false;
    public constructor(
        private readonly logger: Logger,
        initial: Partial<StoredDatabase> | undefined,
        private readonly saveData: (data: StoredDatabase) => Promise<void>,
        vaultKey: string,
        private readonly loadData: () => Promise<StoredDatabase | undefined>
    ) {
        const hasState = initial && Object.keys(initial).length > 0;
        if (
            hasState &&
            initial.vaultKey !== vaultKey &&
            !canRebindEmpty(initial)
        ) {
            throw new Error(
                "Incompatible vault identity. Preserve it for recovery and initialize a separate state store."
            );
        }
        this.state = hasState
            ? { ...(initial as StoredDatabase), vaultKey }
            : emptyState(vaultKey);
    }

    /** Bind an empty database to the configured vault. */
    public async bindVault(vaultKey: string): Promise<void> {
        if (this.state.vaultKey === vaultKey) return;
        if (!canRebindEmpty(this.state))
            throw new Error(
                "Incompatible vault identity. Preserve it for recovery and initialize a separate state store."
            );
        await this.commit({ ...this.state, vaultKey });
    }

    public async commit(next: StoredDatabase): Promise<void> {
        const snapshot = structuredClone(next);
        if (this.needsReload)
            throw new Error(
                "Reload durable state before retrying an uncertain save"
            );
        this.needsReload = true;
        await this.saveData(snapshot);
        this.state = snapshot;
        this.needsReload = false;
    }

    public async recoverPersistence(): Promise<void> {
        if (!this.needsReload) return;
        const saved = await this.loadData();
        if (saved) this.state = saved;
        this.needsReload = false;
    }

    public async save(): Promise<void> {
        await this.commit(this.state);
    }

    public get length(): number {
        return Object.keys(this.state.local).length;
    }

    public getLastSeenUpdateId(): number {
        return this.state.lastSeenUpdateId;
    }

    public getDocumentByDocumentId(id: string): DocumentRecord | undefined {
        const relativePath = this.state.local[id];
        if (relativePath === undefined) return undefined;
        const base = this.state.documents[id]?.base;
        return {
            documentId: id,
            relativePath,
            isDeleted: false,
            metadata: base && {
                parentVersionId: base.vaultUpdateId,
                hash: base.hash,
                remoteRelativePath: this.state.fileManifest.entries[id]
            }
        };
    }

    public getLatestDocumentByRelativePath(
        path: string
    ): DocumentRecord | undefined {
        const id = Object.keys(this.state.local).find(
            (id) => this.state.local[id] === path
        );
        return id === undefined ? undefined : this.getDocumentByDocumentId(id);
    }
}
