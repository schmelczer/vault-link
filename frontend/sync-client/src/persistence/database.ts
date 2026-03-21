export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface StoredDocumentMetadata {
    relativePath: RelativePath;
    documentId: DocumentId;
    parentVersionId: VaultUpdateId;
    remoteRelativePath?: RelativePath;
    hash: string;
    isDeleted?: boolean;
}

export interface StoredPendingDocument {
    relativePath: RelativePath;
    idempotencyKey: string;
    originalCreationPath: RelativePath;
}

export interface StoredDatabase {
    documents: StoredDocumentMetadata[];
    pendingDocuments?: StoredPendingDocument[];
    lastSeenUpdateId: VaultUpdateId | undefined;
}
