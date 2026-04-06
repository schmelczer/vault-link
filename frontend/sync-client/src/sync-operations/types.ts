import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";

export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface DocumentRecord {
    documentId: DocumentId;
    parentVersionId: VaultUpdateId;
    hash: string;
    remoteRelativePath?: RelativePath;
}

export interface StoredDocument extends DocumentRecord {
    relativePath: RelativePath;
}

export interface StoredSyncState {
    documents: StoredDocument[];
    lastSeenUpdateId: VaultUpdateId | undefined;
}

export enum SyncEventType {
    Create = "create",
    SyncLocal = "sync-local",
    SyncRemote = "sync-remote",
    Delete = "delete",
}

export type SyncEvent =
    | { type: SyncEventType.Create; path: RelativePath }
    | { type: SyncEventType.SyncLocal; documentId: DocumentId }
    | {
        type: SyncEventType.Delete;
        documentId: DocumentId;
        path: RelativePath;
        displacedAtVersion?: VaultUpdateId;
    }
    | {
        type: SyncEventType.SyncRemote;
        remoteVersion: DocumentVersionWithoutContent;
    };
