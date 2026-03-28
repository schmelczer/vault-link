export type { DocumentVersion } from "./DocumentVersion";
export type { DocumentVersionWithoutContent } from "./DocumentVersionWithoutContent";
export type { FetchLatestDocumentsResponse } from "./FetchLatestDocumentsResponse";
export type { PingResponse } from "./PingResponse";
export type { VaultHistoryResponse } from "./VaultHistoryResponse";

export type ActionType =
    | "created"
    | "updated"
    | "renamed"
    | "deleted"
    | "restored";

export interface VersionEvent extends DocumentVersionWithoutContent {
    action: ActionType;
    previousPath?: string;
}

export interface TreeNode {
    name: string;
    path: string;
    isFolder: boolean;
    children: TreeNode[];
    document?: DocumentVersionWithoutContent;
    isDeleted?: boolean;
}
