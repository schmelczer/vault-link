import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";

export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface DocumentRecord {
    documentId: DocumentId;
    parentVersionId: VaultUpdateId;
    // Hash of the last server version this client has observed for the doc.
    // `undefined` means we have a record but haven't actually seen content
    // yet — typically a remote-create whose target slot was occupied at
    // receive time, where we deliberately defer the fetch to the reconciler.
    // Consumers should treat undefined as "no comparison possible" (the
    // fast-skip in `processLocalUpdate` falls through to a real upload).
    remoteHash: string | undefined;
    remoteRelativePath: RelativePath;
    // Where the doc's file currently lives on disk. `undefined` means the doc
    // has no local file yet — happens for a remote create whose
    // `remoteRelativePath` slot was occupied at receive time. The reconciler
    // will place the file once the slot frees, fetching content from the
    // server on demand.
    localPath: RelativePath | undefined;
}

export interface StoredSyncState {
    schemaVersion: number;
    documents: DocumentRecord[] | undefined;
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
          path: RelativePath; // current path on disk; mutated in place by `updatePendingCreatePath` when the user renames mid-flight
          resolvers: PromiseWithResolvers<DocumentId>;
      }
    | {
          type: SyncEventType.LocalUpdate;
          documentId: DocumentId | Promise<DocumentId>; // if it's a promise, the promise is fulfilled once the document's create event is processed
          path: RelativePath; // current path on disk
          originalPath: RelativePath; // original path on disk when the event was queued
          isUserRename: boolean; // true iff this event was queued because the user renamed the file
      }
    | {
          type: SyncEventType.LocalDelete;
          documentId: DocumentId | Promise<DocumentId>; // if it's a promise, the promise is fulfilled once the document's create event is processed
          path: RelativePath; // only used for showing on the UI
      }
    | {
          type: SyncEventType.RemoteChange;
          remoteVersion: DocumentVersionWithoutContent;
      };
