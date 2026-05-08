import type { DocumentUpdateResponse } from "./types/DocumentUpdateResponse";
import type { DocumentVersion } from "./types/DocumentVersion";
import type { DocumentVersionWithoutContent } from "./types/DocumentVersionWithoutContent";
import type { FetchLatestDocumentsResponse } from "./types/FetchLatestDocumentsResponse";
import type { ListVaultsResponse } from "./types/ListVaultsResponse";
import type { PingResponse } from "./types/PingResponse";
import type { VaultHistoryResponse } from "./types/VaultHistoryResponse";

async function fetchJsonWithToken<T>(
    path: string,
    token: string,
    init?: RequestInit
): Promise<T> {
    const response = await fetch(path, {
        ...init,
        headers: {
            Authorization: `Bearer ${token}`,
            "device-id": "history-ui",
            ...init?.headers
        }
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`HTTP ${response.status}: ${body}`);
    }
    return response.json() as Promise<T>;
}

export async function listVaults(token: string): Promise<ListVaultsResponse> {
    return fetchJsonWithToken("/vaults", token);
}

export class ApiClient {
    constructor(
        private vaultId: string,
        private token: string
    ) {}

    private get baseUrl(): string {
        return `/vaults/${encodeURIComponent(this.vaultId)}`;
    }

    private async fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
        return fetchJsonWithToken(path, this.token, init);
    }

    async ping(): Promise<PingResponse> {
        return this.fetchJson(`${this.baseUrl}/ping`);
    }

    async fetchLatestDocuments(): Promise<FetchLatestDocumentsResponse> {
        return this.fetchJson(`${this.baseUrl}/documents`);
    }

    async fetchDocumentVersions(
        documentId: string
    ): Promise<DocumentVersionWithoutContent[]> {
        return this.fetchJson(
            `${this.baseUrl}/documents/${documentId}/versions`
        );
    }

    async fetchDocumentVersion(
        documentId: string,
        vaultUpdateId: number
    ): Promise<DocumentVersion> {
        return this.fetchJson(
            `${this.baseUrl}/documents/${documentId}/versions/${vaultUpdateId}`
        );
    }

    async fetchDocumentVersionContent(
        documentId: string,
        vaultUpdateId: number
    ): Promise<ArrayBuffer> {
        const response = await fetch(
            `${this.baseUrl}/documents/${documentId}/versions/${vaultUpdateId}/content`,
            {
                headers: {
                    Authorization: `Bearer ${this.token}`,
                    "device-id": "history-ui"
                }
            }
        );
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        return response.arrayBuffer();
    }

    async fetchVaultHistory(
        limit?: number,
        beforeUpdateId?: number
    ): Promise<VaultHistoryResponse> {
        const params = new URLSearchParams();
        if (limit !== undefined) params.set("limit", String(limit));
        if (beforeUpdateId !== undefined)
            params.set("before_update_id", String(beforeUpdateId));
        const qs = params.toString();
        return this.fetchJson(`${this.baseUrl}/history${qs ? `?${qs}` : ""}`);
    }

    /**
     * Upload a new version of an existing (non-deleted) document. The
     * server treats this like any other edit — server-side merging,
     * path dedupe, and broadcast still apply. Used by the UI to restore
     * an old version by re-submitting its bytes on top of the latest.
     */
    async updateBinaryDocument(
        documentId: string,
        parentVersionId: number,
        relativePath: string,
        content: ArrayBuffer
    ): Promise<DocumentUpdateResponse> {
        const form = new FormData();
        form.append("parent_version_id", String(parentVersionId));
        form.append("relative_path", relativePath);
        form.append("content", new Blob([content]));
        return this.fetchJson(
            `${this.baseUrl}/documents/${documentId}/binary`,
            { method: "PUT", body: form }
        );
    }

    /**
     * Create a new document. Used by the UI to restore a deleted
     * document: `update_document` short-circuits on `is_deleted`, so
     * resurrection has to go through `create_document` — which detects
     * an existing doc at the same path, merges or dedupes as needed,
     * and returns the resulting version.
     */
    async createDocument(
        lastSeenVaultUpdateId: number,
        relativePath: string,
        content: ArrayBuffer
    ): Promise<DocumentUpdateResponse> {
        const form = new FormData();
        form.append("last_seen_vault_update_id", String(lastSeenVaultUpdateId));
        form.append("relative_path", relativePath);
        form.append("content", new Blob([content]));
        return this.fetchJson(`${this.baseUrl}/documents`, {
            method: "POST",
            body: form
        });
    }
}
