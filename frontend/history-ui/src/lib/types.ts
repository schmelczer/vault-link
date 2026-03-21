export interface DocumentVersionWithoutContent {
    vaultUpdateId: number;
    documentId: string;
    relativePath: string;
    updatedDate: string;
    isDeleted: boolean;
    userId: string;
    deviceId: string;
    contentSize: number;
}

export interface DocumentVersion {
    vaultUpdateId: number;
    documentId: string;
    relativePath: string;
    updatedDate: string;
    contentBase64: string;
    isDeleted: boolean;
    userId: string;
    deviceId: string;
}

export interface FetchLatestDocumentsResponse {
    latestDocuments: DocumentVersionWithoutContent[];
    lastUpdateId: number;
}

export interface VaultHistoryResponse {
    versions: DocumentVersionWithoutContent[];
    hasMore: boolean;
}

export interface PingResponse {
    serverVersion: string;
    isAuthenticated: boolean;
    mergeableFileExtensions: string[];
    supportedApiVersion: number;
}

export type ActionType = "created" | "updated" | "renamed" | "deleted" | "restored";

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
