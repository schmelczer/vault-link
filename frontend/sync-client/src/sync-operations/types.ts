import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";

export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface DocumentRecord {
    documentId: DocumentId;
    parentVersionId: VaultUpdateId;
    remoteHash: string;
    remoteRelativePath: RelativePath;
}

export interface DocumentWithPath {
    path: RelativePath;
    record: DocumentRecord;
}

export interface StoredDocument extends DocumentRecord {
    relativePath: RelativePath;
}

export interface StoredSyncState {
    documents: StoredDocument[] | undefined;
    lastSeenUpdateId: VaultUpdateId | undefined;
}

export enum SyncEventType {
    LocalCreate = "local-create",
    LocalUpdate = "local-update", // includes both content and path changes
    LocalDelete = "local-delete",
    RemoteChange = "remote-change" // includes every type of create/update/delete coming from the server
}

export type FileSyncEvent =
    | { type: SyncEventType.LocalCreate; path: RelativePath }
    | {
          type: SyncEventType.LocalUpdate;
          path: RelativePath;
          oldPath?: RelativePath; // oldPath is undefined for content changes
      }
    | { type: SyncEventType.LocalDelete; path: RelativePath }
    | {
          type: SyncEventType.RemoteChange;
          remoteVersion: DocumentVersionWithoutContent;
      };

export type SyncEvent =
    | {
          type: SyncEventType.LocalCreate;
          path: RelativePath; // current path on disk
          originalPath: RelativePath; // original path on disk when the event was queued
          resolvers: PromiseWithResolvers<DocumentId>;
      }
    | {
          type: SyncEventType.LocalUpdate;
          documentId: DocumentId | Promise<DocumentId>; // if it's a promise, the promise is fulfilled once the document's create event is processed
          path: RelativePath; // current path on disk
          originalPath: RelativePath; // original path on disk when the event was queued
          // no need to store the old path in case of a rename; the server will figure it out from the parent's path
      }
    | {
          type: SyncEventType.LocalDelete;
          documentId: DocumentId | Promise<DocumentId>; // if it's a promise, the promise is fulfilled once the document's create event is processed
      }
    | {
          type: SyncEventType.RemoteChange;
          remoteVersion: DocumentVersionWithoutContent;
      };
