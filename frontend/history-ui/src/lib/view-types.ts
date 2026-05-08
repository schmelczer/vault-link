import type { DocumentVersionWithoutContent } from "./types/DocumentVersionWithoutContent";

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
