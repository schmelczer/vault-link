import type {
    DocumentVersion,
    DocumentVersionWithoutContent,
    FetchLatestDocumentsResponse,
    ListVaultsResponse,
    PingResponse,
    VaultHistoryResponse
} from "./types";

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

export async function listVaults(
    token: string
): Promise<ListVaultsResponse> {
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

    private async fetchJson<T>(
        path: string,
        init?: RequestInit
    ): Promise<T> {
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
        return this.fetchJson(
            `${this.baseUrl}/history${qs ? `?${qs}` : ""}`
        );
    }

    async restoreVersion(
        documentId: string,
        vaultUpdateId: number
    ): Promise<DocumentVersionWithoutContent> {
        return this.fetchJson(
            `${this.baseUrl}/documents/${documentId}/restore`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ vaultUpdateId })
            }
        );
    }
}
