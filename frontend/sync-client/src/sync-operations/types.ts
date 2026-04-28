import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";

export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface DocumentRecord {
    // The doc's current local disk path. The queue's `documents` map is
    // keyed by this same string and the invariant `documents.get(record.path)
    // === record` is held by every queue mutation. Stored as a field on the
    // record (not just as the map key) so callers can hold a stable
    // reference to the record and read `.path` for the live value rather
    // than capturing a string into a local variable that goes stale on the
    // next rename.
    path: RelativePath;
    // Set when the doc's local file lives at a `conflict-<uuid>-` path
    // because an earlier remote create / remote rename couldn't claim the
    // path the server has it at (it was occupied locally at the time).
    // Server-bound requests for this doc must use `intendedPath` rather
    // than `path`, otherwise the server would learn about the local
    // conflict-uuid path and propagate it as the doc's canonical location
    // to every other client. `undefined` for docs whose local path matches
    // the server's view.
    intendedPath?: RelativePath;
    documentId: DocumentId;
    parentVersionId: VaultUpdateId;
    remoteHash: string;
    remoteRelativePath: RelativePath;
}

export interface StoredSyncState {
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
        path: RelativePath; // current path on disk
        originalPath: RelativePath; // original path on disk when the event was queued
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
        path: RelativePath;  // only used for showing on the UI
    }
    | {
        type: SyncEventType.RemoteChange;
        remoteVersion: DocumentVersionWithoutContent;
    };
