import type { Settings } from "../persistence/settings";
import type { DocumentUpdateResponse } from "./types/DocumentUpdateResponse";
import type { DocumentVersionWithoutContent } from "./types/DocumentVersionWithoutContent";
import type { EventBatch } from "./types/EventBatch";
import type { FileManifestUpdateResponse } from "./types/FileManifestUpdateResponse";
import type { PutFileContent } from "./types/PutFileContent";
import type { PushFileManifest } from "./types/PushFileManifest";
import type { VaultSnapshot } from "./types/VaultSnapshot";
import type { PingResponse } from "./types/PingResponse";
import {
    AuthenticationError,
    PermanentSyncError,
    ServerHistoryChangedError,
    SyncResetError
} from "../errors/errors";

// Injected fetch implementations may ignore cancellation. Stop waiting anyway,
// and never let their late responses reach checkpoint or engine persistence.
async function abortable<T>(
    signal: AbortSignal,
    operation: () => Promise<T>
): Promise<T> {
    signal.throwIfAborted();
    let abort = (): void => undefined;
    try {
        return await Promise.race([
            new Promise<never>((_, reject) => {
                abort = (): void => {
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Only reset errors and timeout errors reach this helper.
                    reject(signal.reason);
                };
                signal.addEventListener("abort", abort, { once: true });
            }),
            operation()
        ]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}

export class SyncService {
    private session = new AbortController();

    public constructor(
        private readonly deviceId: string,
        private readonly settings: Settings,
        private readonly fetchImplementation: typeof fetch = globalThis.fetch,
        private readonly history?: {
            get: () => string | undefined;
            save: (checkpoint: string | undefined) => Promise<void>;
        }
    ) {
        this.pause();
    }

    public get verifiesHistory(): boolean {
        return this.history !== undefined;
    }
    public get hasHistoryCheckpoint(): boolean {
        return this.history?.get() !== undefined;
    }

    public resume(): void {
        this.session = new AbortController();
    }

    public pause(): void {
        this.session.abort(new SyncResetError());
    }

    public async resetHistory(): Promise<void> {
        await this.history?.save(undefined);
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
        return this.request(
            `/documents/${documentId}/versions/${vaultUpdateId}/content`,
            undefined,
            false,
            async (response) => new Uint8Array(await response.arrayBuffer())
        );
    }

    private historyHeaders(): Record<string, string> {
        const checkpoint = this.history?.get();
        return checkpoint !== undefined && checkpoint !== ""
            ? { "X-Vault-Link-History": checkpoint }
            : {};
    }

    private async recordHistory(response: Response): Promise<void> {
        const checkpoint = response.headers.get("x-vault-link-history");
        if (
            checkpoint !== null &&
            checkpoint !== "" &&
            this.history !== undefined
        ) {
            const previous = this.history.get();
            if (checkpoint === previous) return;
            if (
                previous === undefined ||
                previous === "" ||
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

    private getUrl(path: string): string {
        const { remoteUri, vaultName } = this.settings.getSettings();
        return `${remoteUri.replace(/\/$/u, "")}/vaults/${encodeURIComponent(vaultName)}${path}`;
    }

    private async request<T>(
        path: string,
        body?: unknown,
        raw = false,
        decode: (response: Response) => Promise<T> = async (response) =>
            // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Endpoint methods supply the generated protocol response type.
            response.json() as Promise<T>
    ): Promise<T> {
        const timeout = AbortSignal.timeout(
            this.settings.getSettings().requestTimeoutMs
        );
        const signal = raw
            ? timeout
            : AbortSignal.any([timeout, this.session.signal]);
        const response = await abortable(signal, async () =>
            this.fetchImplementation(this.getUrl(path), {
                method: body === undefined ? "GET" : "PUT",
                body: body === undefined ? undefined : JSON.stringify(body),
                signal,
                headers: {
                    ...(raw ? {} : this.historyHeaders()),
                    Authorization: `Bearer ${this.settings.getSettings().token}`,
                    "Device-Id": this.deviceId,
                    "Content-Type": "application/json"
                }
            })
        );
        signal.throwIfAborted();
        this.checkHistory(response);
        if (!response.ok) {
            this.throwForErrorResponse(
                response,
                `HTTP ${response.status}: ${await abortable(signal, async () => response.text())}`
            );
        }

        // Finish metadata saves even if the transport is paused meanwhile.
        if (!raw) await this.recordHistory(response);
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
