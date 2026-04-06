import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";

export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface DocumentRecord {
    documentId: DocumentId;
    parentVersionId: VaultUpdateId;
    remoteHash: string;
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
    Delete = "delete",
    SyncRemote = "sync-remote",
}

export type SyncEvent =
    | {
        type: SyncEventType.Create;
        path: RelativePath;   // current path on disk
        originalPath: RelativePath; // original path on disk when the event was created
        resolvers?: PromiseWithResolvers<DocumentId>
    }
    | {
        type: SyncEventType.SyncLocal;
        documentId: DocumentId | Promise<DocumentId>; // if it's a promise, the promise is fulfilled once the document's create event is processed
        path: RelativePath; // current path on disk
        originalPath: RelativePath; // original path on disk when the event was created
    }
    | {
        type: SyncEventType.Delete;
        documentId: DocumentId | Promise<DocumentId>;  // if it's a promise, the promise is fulfilled once the document's create event is processed
    }
    | {
        type: SyncEventType.SyncRemote;
        remoteVersion: DocumentVersionWithoutContent;
    };
