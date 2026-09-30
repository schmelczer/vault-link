import { HISTORY_HEADER, HISTORY_MISMATCH_HEADER } from "../consts";
import type { DocumentId, VaultUpdateId } from "../persistence/database";
import type { Settings } from "../persistence/settings";
import { abortable } from "../utils/abortable";
import type { DocumentUpdateResponse } from "./types/DocumentUpdateResponse";
import type { DocumentVersionWithoutContent } from "./types/DocumentVersionWithoutContent";
import type { EventBatch } from "./types/EventBatch";
import type { FileManifestUpdateResponse } from "./types/FileManifestUpdateResponse";
import type { PutFileContent } from "./types/PutFileContent";
import type { PushFileManifest } from "./types/PushFileManifest";
import type { VaultSnapshot } from "./types/VaultSnapshot";
import type { ServerConfigResponse } from "./types/ServerConfigResponse";
import {
    AuthenticationError,
    PermanentSyncError,
    ServerHistoryChangedError,
    SyncResetError
} from "../errors/errors";

export class SyncService {
    private readonly fetchImplementation: typeof fetch;
    private session = new AbortController();

    public constructor(
        private readonly deviceId: string,
        private readonly settings: Settings,
        fetchImplementation: typeof fetch | undefined,
        private readonly history: {
            get: () => string | undefined;
            save: (checkpoint: string | undefined) => Promise<void>;
        }
    ) {
        this.fetchImplementation = fetchImplementation ?? globalThis.fetch;
        this.pause();
    }

    public pause(): void {
        this.session.abort(new SyncResetError());
    }

    public resume(): void {
        this.session = new AbortController();
    }

    public async resetHistory(): Promise<void> {
        await this.history.save(undefined);
    }

    public async getServerConfig(
        ignoreAborts = true
    ): Promise<ServerConfigResponse> {
        return this.request("/config", {
            ignoreAborts,
            recordCheckpoint: false
        });
    }

    public async getVaultSnapshot(): Promise<VaultSnapshot> {
        return this.request("/vault-snapshot");
    }

    public async getEvents(after: VaultUpdateId): Promise<EventBatch> {
        return this.request(`/events-since?after=${after}`);
    }

    public async pushFileManifest(
        request: PushFileManifest
    ): Promise<FileManifestUpdateResponse> {
        return this.request("/file-manifest", { body: request });
    }

    public async putFileContent(
        id: DocumentId,
        request: PutFileContent
    ): Promise<DocumentUpdateResponse> {
        return this.request(`/documents/${id}`, { body: request });
    }

    public async getDocumentMetadata(
        id: DocumentId
    ): Promise<DocumentVersionWithoutContent> {
        return this.request(`/documents/${id}/metadata`);
    }

    public async getDocumentVersionContent({
        documentId,
        vaultUpdateId
    }: {
        documentId: DocumentId;
        vaultUpdateId: VaultUpdateId;
    }): Promise<Uint8Array> {
        return this.request(
            `/documents/${documentId}/versions/${vaultUpdateId}/content`,
            {
                decode: async (response) =>
                    new Uint8Array(await response.arrayBuffer())
            }
        );
    }

    private async recordHistory(response: Response): Promise<void> {
        const checkpoint = response.headers.get(HISTORY_HEADER);
        if (checkpoint === null || checkpoint === "") {
            throw new PermanentSyncError(
                "Missing server history checkpoint HTTP header"
            );
        }

        const previous = this.history.get();
        if (checkpoint === previous) {
            return;
        }

        if (
            previous === undefined ||
            Number(checkpoint.split(":")[0]) >= Number(previous.split(":")[0])
        ) {
            await this.history.save(checkpoint);
        }
    }

    private async request<T>(
        path: string,
        {
            body,
            ignoreAborts = false,
            recordCheckpoint = true,
            decode = async (response): Promise<T> =>
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Endpoint methods supply the generated protocol response type.
                response.json() as Promise<T>
        }: {
            body?: unknown;
            ignoreAborts?: boolean;
            recordCheckpoint?: boolean;
            decode?: (response: Response) => Promise<T>;
        } = {}
    ): Promise<T> {
        const { remoteUri, vaultName, token, requestTimeoutMs } =
            this.settings.getSettings();
        const url = `${remoteUri.replace(/\/$/u, "")}/vaults/${encodeURIComponent(vaultName)}${path}`;
        const checkpoint = ignoreAborts ? undefined : this.history.get();

        const timeout = AbortSignal.timeout(requestTimeoutMs);
        const signal = ignoreAborts
            ? timeout
            : AbortSignal.any([timeout, this.session.signal]);

        const response = await abortable(signal, async () =>
            this.fetchImplementation(url, {
                method: body === undefined ? "GET" : "PUT",
                body: body === undefined ? undefined : JSON.stringify(body),
                signal,
                headers: {
                    ...(checkpoint === undefined
                        ? {}
                        : { [HISTORY_HEADER]: checkpoint }),
                    Authorization: `Bearer ${token}`,
                    "Device-Id": this.deviceId,
                    "Content-Type": "application/json"
                }
            })
        );

        signal.throwIfAborted();
        if (response.headers.get(HISTORY_MISMATCH_HEADER) === "1") {
            throw new ServerHistoryChangedError(
                "Server history changed; recovering local work"
            );
        }

        if (!response.ok) {
            this.throwForErrorResponse(
                response,
                `HTTP ${response.status}: ${await abortable(signal, async () => response.text())}`
            );
        }

        // Finish metadata saves even if the transport is paused meanwhile.
        if (!ignoreAborts && recordCheckpoint) {
            await this.recordHistory(response);
        }

        return abortable(signal, async () => decode(response));
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
}
