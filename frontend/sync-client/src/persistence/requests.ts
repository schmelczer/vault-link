import type { SyncEventType } from "../services/protocol-types";
import type { PutFileContent } from "../services/types/PutFileContent";
import type { PushFileManifest } from "../services/types/PushFileManifest";
import type { DocumentId } from "./database";

// Exact wire payload retained until acknowledgement, including after rejection.
export type PendingRequest = { rejection?: string } & (
    | {
          type: SyncEventType.Content;
          documentId: DocumentId;
          request: PutFileContent;
          hash: string;
      }
    | { type: SyncEventType.FileManifest; request: PushFileManifest }
);
