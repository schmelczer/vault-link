import type { Settings } from "../persistence/settings";
import type { FetchController } from "./fetch-controller";
import type { Logger } from "../tracing/logger";
import type { DocumentUpdateResponse } from "./types/DocumentUpdateResponse";
import type { DocumentVersion } from "./types/DocumentVersion";
import type { DocumentVersionWithoutContent } from "./types/DocumentVersionWithoutContent";
import type { EventBatch } from "./types/EventBatch";
import type { FileManifest } from "./types/FileManifest";
import type { FileManifestUpdateResponse } from "./types/FileManifestUpdateResponse";
import type { PutFileContent } from "./types/PutFileContent";
import type { PushFileManifest } from "./types/PushFileManifest";
import type { VaultSnapshot } from "./types/VaultSnapshot";
import type { PingResponse } from "./types/PingResponse";
import {
    AuthenticationError,
    PermanentSyncError,
    ServerHistoryChangedError
} from "../errors/errors";

export class SyncService {
    private readonly client: typeof fetch;
    private readonly rawFetch: typeof fetch;

    public constructor(
        private readonly deviceId: string,
        fetchController: FetchController,
        private readonly settings: Settings,
        logger: Logger,
        fetchImplementation: typeof fetch = globalThis.fetch,
        private readonly history?: {
            get: () => string | undefined;
            save: (checkpoint: string | undefined) => Promise<void>;
        }
    ) {
        this.rawFetch = async (...args) => fetchImplementation(...args);
        this.client = fetchController.getControlledFetchImplementation(
            logger,
            this.rawFetch
        );
    }

    public get verifiesHistory(): boolean {
        return this.history !== undefined;
    }
    public get hasHistoryCheckpoint(): boolean {
        return this.history?.get() !== undefined;
    }

    public async resetHistory(): Promise<void> {
        await this.history?.save(undefined);
    }

    private historyHeaders(): Record<string, string> {
        const checkpoint = this.history?.get();
        return checkpoint ? { "X-Vault-Link-History": checkpoint } : {};
    }

    private async recordHistory(response: Response): Promise<void> {
        const checkpoint = response.headers.get("x-vault-link-history");
        if (checkpoint && this.history) {
            const previous = this.history.get();
            if (
                !previous ||
                Number(checkpoint.split(":")[0]) >=
                    Number(previous.split(":")[0])
            )
                await this.history.save(checkpoint);
        }
    }

    private checkHistory(response: Response): void {
        if (response.headers.get("x-vault-link-history-mismatch") === "1")
            throw new ServerHistoryChangedError(
                "Server history changed; recovering local work"
            );
    }

    public getUrl(path: string): string {
        const { remoteUri, vaultName } = this.settings.getSettings();
        return `${remoteUri.replace(/\/$/u, "")}/vaults/${encodeURIComponent(vaultName)}${path}`;
    }

    private async request<T>(
        path: string,
        body?: unknown,
        raw = false
    ): Promise<T> {
        const response = await (raw ? this.rawFetch : this.client)(
            this.getUrl(path),
            {
                method: body === undefined ? "GET" : "PUT",
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(
                    this.settings.getSettings().requestTimeoutMs
                ),
                headers: {
                    ...(raw ? {} : this.historyHeaders()),
                    Authorization: `Bearer ${this.settings.getSettings().token}`,
                    "Device-Id": this.deviceId,
                    "Content-Type": "application/json"
                }
            }
        );

        this.checkHistory(response);
        if (!response.ok) {
            this.throwForErrorResponse(
                response,
                `HTTP ${response.status}: ${await response.text()}`
            );
        }

        if (!raw) await this.recordHistory(response);
        return (await response.json()) as T;
    }

    private throwForErrorResponse(response: Response, message: string): never {
        if (response.status === 401 || response.status === 403) {
            throw new AuthenticationError(message);
        }
        if (
            response.status >= 400 &&
            response.status < 500 &&
            response.status !== 408 &&
            response.status !== 429
        ) {
            throw new PermanentSyncError(message);
        }
        throw new Error(message);
    }

    public async ping(): Promise<PingResponse> {
        return this.request("/ping", undefined, true);
    }

    public async vaultSnapshot(): Promise<VaultSnapshot> {
        return this.request("/vault-snapshot");
    }

    public async events(after: number): Promise<EventBatch> {
        return this.request(`/events-since?after=${after}`);
    }

    public async fileManifest(): Promise<FileManifest> {
        return this.request("/file-manifest");
    }

    public async pushFileManifest(
        request: PushFileManifest
    ): Promise<FileManifestUpdateResponse> {
        return this.request("/file-manifest", request);
    }

    public async putFileContent(
        id: string,
        request: PutFileContent
    ): Promise<DocumentUpdateResponse> {
        return this.request(`/documents/${id}`, request);
    }

    public async get(id: string): Promise<DocumentVersion> {
        return this.request(`/documents/${id}`);
    }

    public async metadata(id: string): Promise<DocumentVersionWithoutContent> {
        return this.request(`/documents/${id}/metadata`);
    }

    public async getDocumentVersionContent({
        documentId,
        vaultUpdateId
    }: {
        documentId: string;
        vaultUpdateId: number;
    }): Promise<Uint8Array> {
        const response = await this.client(
            this.getUrl(
                `/documents/${documentId}/versions/${vaultUpdateId}/content`
            ),
            {
                signal: AbortSignal.timeout(
                    this.settings.getSettings().requestTimeoutMs
                ),
                headers: {
                    ...this.historyHeaders(),
                    Authorization: `Bearer ${this.settings.getSettings().token}`
                }
            }
        );

        this.checkHistory(response);
        if (!response.ok) {
            this.throwForErrorResponse(
                response,
                `Cannot fetch version ${vaultUpdateId}: HTTP ${response.status}`
            );
        }

        await this.recordHistory(response);
        return new Uint8Array(await response.arrayBuffer());
    }
}
