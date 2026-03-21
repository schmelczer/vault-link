import type {
    DocumentId,
    RelativePath,
    VaultUpdateId
} from "../persistence/database";

import type { Logger } from "../tracing/logger";
import type { Settings } from "../persistence/settings";
import type { FetchController } from "./fetch-controller";
import { sleep } from "../utils/sleep";
import { SyncResetError } from "../errors/sync-reset-error";
import { HttpClientError } from "../errors/http-client-error";
import type { SerializedError } from "./types/SerializedError";
import type { DocumentVersionWithoutContent } from "./types/DocumentVersionWithoutContent";
import type { DocumentUpdateResponse } from "./types/DocumentUpdateResponse";
import type { DocumentVersion } from "./types/DocumentVersion";
import type { FetchLatestDocumentsResponse } from "./types/FetchLatestDocumentsResponse";
import type { PingResponse } from "./types/PingResponse";
import type { DeleteDocumentVersion } from "./types/DeleteDocumentVersion";
import type { UpdateTextDocumentVersion } from "./types/UpdateTextDocumentVersion";

export class SyncService {
    private readonly client: typeof globalThis.fetch;
    private readonly pingClient: typeof globalThis.fetch;

    public constructor(
        private readonly deviceId: string,
        private readonly fetchController: FetchController,
        private readonly settings: Settings,
        private readonly logger: Logger,
        fetchImplementation: typeof globalThis.fetch = globalThis.fetch
    ) {
        // ensure that if it's called a method, `this` won't be bound to the instance
        const unboundFetch: typeof globalThis.fetch = async (...args) =>
            fetchImplementation(...args);

        this.client = this.fetchController.getControlledFetchImplementation(
            this.logger,
            unboundFetch
        );
        this.pingClient = unboundFetch;
    }

    private static async errorFromResponse(
        response: Response
    ): Promise<string> {
        if (
            response.headers
                .get("Content-Type")
                ?.includes("application/json") == true
        ) {
            try {
                const result: SerializedError =
                    (await response.json()) as SerializedError; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
                return SyncService.formatError(result);
            } catch {
                return `HTTP ${response.status}: ${response.statusText} (failed to parse error response body)`;
            }
        }
        return `HTTP ${response.status}: ${response.statusText}`;
    }

    /**
     * Safely parse JSON from a response body. If parsing fails (e.g., malformed
     * JSON from the server), throws an HttpClientError with status 0 so that
     * retryForever does not retry indefinitely.
     */
    private static async parseJsonResponse<T>(
        response: Response
    ): Promise<T> {
        try {
            return (await response.json()) as T; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
        } catch (error) {
            // Timeout and abort errors are transient — let them propagate
            // so retryForever can retry. Only wrap genuine parse failures
            // (malformed JSON) as HttpClientError to prevent infinite retries.
            if (
                error instanceof Error &&
                (error.name === "TimeoutError" || error.name === "AbortError")
            ) {
                throw error;
            }
            throw new HttpClientError(
                0,
                `Failed to parse JSON response: ${error}`
            );
        }
    }

    private static formatError(error: SerializedError): string {
        let result = error.message;
        if (error.causes.length > 0) {
            const causes = error.causes.join(", ");
            result += ` caused by: ${causes}`;
        }

        return result;
    }

    private static async throwHttpError(
        response: Response,
        context: string
    ): Promise<never> {
        const message = `${context}: ${await SyncService.errorFromResponse(response)}`;
        if (response.status >= 400 && response.status < 500) {
            throw new HttpClientError(response.status, message);
        }
        throw new Error(message);
    }

    public async create({
        relativePath,
        contentBytes,
        idempotencyKey
    }: {
        relativePath: RelativePath;
        contentBytes: Uint8Array;
        idempotencyKey?: string;
    }): Promise<DocumentUpdateResponse> {
        return this.retryForever(async () => {
            const formData = new FormData();

            formData.append("relative_path", relativePath);
            formData.append(
                "content",
                new Blob([new Uint8Array(contentBytes)])
            );

            if (idempotencyKey !== undefined) {
                formData.append("idempotency_key", idempotencyKey);
            }

            this.logger.debug(
                `Creating document with relative path ${relativePath}`
            );

            const response = await this.client(this.getUrl("/documents"), {
                method: "POST",
                body: formData,
                headers: this.getDefaultHeaders()
            });

            if (!response.ok) {
                await SyncService.throwHttpError(
                    response,
                    "Failed to create document"
                );
            }

            const result: DocumentUpdateResponse =
                await SyncService.parseJsonResponse<DocumentUpdateResponse>(
                    response
                );

            this.logger.debug(`Created document ${JSON.stringify(result)}`);

            return result;
        });
    }

    public async putText({
        parentVersionId,
        documentId,
        relativePath,
        content
    }: {
        parentVersionId: VaultUpdateId;
        documentId: DocumentId;
        relativePath: RelativePath;
        content: (number | string)[];
    }): Promise<DocumentUpdateResponse> {
        return this.retryForever(async () => {
            this.logger.debug(
                `Updating text document ${documentId} with parent version ${parentVersionId} and relative path ${relativePath}, content [${content.join(", ")}]`
            );

            const request: UpdateTextDocumentVersion = {
                parentVersionId,
                relativePath,
                content
            };

            const response = await this.client(
                this.getUrl(`/documents/${documentId}/text`),
                {
                    method: "PUT",
                    body: JSON.stringify(request),
                    headers: this.getDefaultHeaders({ type: "json" })
                }
            );

            if (!response.ok) {
                await SyncService.throwHttpError(
                    response,
                    "Failed to update document"
                );
            }

            const result: DocumentUpdateResponse =
                await SyncService.parseJsonResponse<DocumentUpdateResponse>(
                    response
                );

            this.logger.debug(
                `Updated document ${JSON.stringify(result)} with id ${result.documentId
                }}`
            );

            return result;
        });
    }

    public async putBinary({
        parentVersionId,
        documentId,
        relativePath,
        contentBytes
    }: {
        parentVersionId: VaultUpdateId;
        documentId: DocumentId;
        relativePath: RelativePath;
        contentBytes: Uint8Array;
    }): Promise<DocumentUpdateResponse> {
        return this.retryForever(async () => {
            this.logger.debug(
                `Updating binary document ${documentId} with parent version ${parentVersionId} and relative path ${relativePath}`
            );
            const formData = new FormData();
            formData.append("parent_version_id", parentVersionId.toString());
            formData.append("relative_path", relativePath);
            formData.append(
                "content",
                new Blob([new Uint8Array(contentBytes)])
            );

            const response = await this.client(
                this.getUrl(`/documents/${documentId}/binary`),
                {
                    method: "PUT",
                    body: formData,
                    headers: this.getDefaultHeaders()
                }
            );

            if (!response.ok) {
                await SyncService.throwHttpError(
                    response,
                    "Failed to update document"
                );
            }

            const result: DocumentUpdateResponse =
                await SyncService.parseJsonResponse<DocumentUpdateResponse>(
                    response
                );

            this.logger.debug(
                `Updated document ${JSON.stringify(result)} with id ${result.documentId
                }}`
            );

            return result;
        });
    }

    public async delete({
        documentId,
        relativePath
    }: {
        documentId: DocumentId;
        relativePath: RelativePath;
    }): Promise<DocumentVersionWithoutContent> {
        return this.retryForever(async () => {
            const request: DeleteDocumentVersion = {};

            this.logger.debug(
                `Delete document with id ${documentId} and relative path ${relativePath}`
            );

            const response = await this.client(
                this.getUrl(`/documents/${documentId}`),
                {
                    method: "DELETE",
                    body: JSON.stringify(request),
                    headers: this.getDefaultHeaders({ type: "json" })
                }
            );

            if (!response.ok) {
                await SyncService.throwHttpError(
                    response,
                    "Failed to delete document"
                );
            }

            const result: DocumentVersionWithoutContent =
                await SyncService.parseJsonResponse<DocumentVersionWithoutContent>(
                    response
                );

            this.logger.debug(
                `Deleted document ${relativePath} with id ${documentId}`
            );

            return result;
        });
    }

    public async get({
        documentId
    }: {
        documentId: DocumentId;
    }): Promise<DocumentVersion> {
        return this.retryForever(async () => {
            this.logger.debug(`Getting document with id ${documentId}`);

            const response = await this.client(
                this.getUrl(`/documents/${documentId}`),
                {
                    headers: this.getDefaultHeaders()
                }
            );

            if (!response.ok) {
                await SyncService.throwHttpError(
                    response,
                    "Failed to get document"
                );
            }

            const result: DocumentVersion =
                await SyncService.parseJsonResponse<DocumentVersion>(
                    response
                );

            this.logger.debug(`Got document ${JSON.stringify(result)}`);

            return result;
        });
    }

    public async getDocumentVersionContent({
        documentId,
        vaultUpdateId
    }: {
        documentId: DocumentId;
        vaultUpdateId: VaultUpdateId;
    }): Promise<Uint8Array> {
        return this.retryForever(async () => {
            this.logger.debug(
                `Getting document with id ${documentId} and version ${vaultUpdateId}`
            );

            const response = await this.client(
                this.getUrl(
                    `/documents/${documentId}/versions/${vaultUpdateId}/content`
                ),
                {
                    headers: this.getDefaultHeaders()
                }
            );

            if (!response.ok) {
                await SyncService.throwHttpError(
                    response,
                    "Failed to get document"
                );
            }

            const result = await response.bytes();
            this.logger.debug(
                `Got document version content for document ${documentId} version ${vaultUpdateId}`
            );
            return result;
        });
    }

    public async getAll(
        since?: VaultUpdateId
    ): Promise<FetchLatestDocumentsResponse> {
        return this.retryForever(async () => {
            this.logger.debug(
                "Getting all documents" +
                (since != null ? ` since ${since}` : "")
            );

            const url = new URL(this.getUrl("/documents"));
            if (since !== undefined) {
                url.searchParams.append("since", since.toString());
            }
            const response = await this.client(url.toString(), {
                headers: this.getDefaultHeaders()
            });

            if (!response.ok) {
                await SyncService.throwHttpError(
                    response,
                    "Failed to get documents"
                );
            }

            const result: FetchLatestDocumentsResponse =
                await SyncService.parseJsonResponse<FetchLatestDocumentsResponse>(
                    response
                );

            this.logger.debug(
                `Got ${result.latestDocuments.length} document metadata`
            );

            return result;
        });
    }

    public async resolveIdempotencyKeys(
        keys: string[]
    ): Promise<Map<string, string>> {
        this.logger.debug(
            `Resolving ${keys.length} idempotency keys`
        );

        return this.retryForever(async () => {
            const response = await this.client(
                this.getUrl("/documents/resolve-keys"),
                {
                    method: "POST",
                    body: JSON.stringify({ idempotencyKeys: keys }),
                    headers: this.getDefaultHeaders({ type: "json" })
                }
            );

            if (!response.ok) {
                await SyncService.throwHttpError(
                    response,
                    "Failed to resolve idempotency keys"
                );
            }

            const result =
                await SyncService.parseJsonResponse<{
                    resolved: Record<string, string>;
                }>(response);

            const resolved = new Map<string, string>(
                Object.entries(result.resolved)
            );

            this.logger.debug(
                `Resolved ${resolved.size}/${keys.length} idempotency keys`
            );

            return resolved;
        });
    }

    public async ping(): Promise<PingResponse> {
        this.logger.debug("Pinging server");
        const response = await this.pingClient(this.getUrl("/ping"), {
            headers: this.getDefaultHeaders()
        });

        if (!response.ok) {
            throw new Error(
                `Failed to ping server: ${await SyncService.errorFromResponse(
                    response
                )}`
            );
        }

        const result: PingResponse =
            await SyncService.parseJsonResponse<PingResponse>(response);

        this.logger.debug(
            `Pinged server, got response: ${JSON.stringify(result)}`
        );

        return result;
    }

    private getUrl(path: string): string {
        const { vaultName, remoteUri } = this.settings.getSettings();
        const remoteUriWithoutTrailingSlash = remoteUri.replace(/\/+$/, "");
        const encodedVaultName = encodeURIComponent(vaultName.trim());
        return `${remoteUriWithoutTrailingSlash}/vaults/${encodedVaultName}${path}`;
    }

    private getDefaultHeaders(
        { type }: { type?: "json" } = { type: undefined }
    ): Record<string, string> {
        const headers: Record<string, string> = {
            "device-id": this.deviceId,
            authorization: `Bearer ${this.settings.getSettings().token}`
        };

        if (type === "json") {
            headers["Content-Type"] = "application/json";
        }

        return headers;
    }

    private async retryForever<T>(fn: () => Promise<T>): Promise<T> {
        let attempt = 0;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        while (true) {
            try {
                return await fn();
            } catch (e) {
                // We must not retry errors coming from reset
                if (e instanceof SyncResetError) {
                    throw e;
                }

                // Don't retry 4xx client errors — the request itself is wrong
                // and retrying won't help
                if (e instanceof HttpClientError) {
                    throw e;
                }

                attempt++;
                const baseDelay =
                    this.settings.getSettings().networkRetryIntervalMs;
                const exponentialDelay = Math.min(
                    baseDelay * Math.pow(2, Math.min(attempt - 1, 5)),
                    30000
                );
                const jitter = Math.random() * exponentialDelay * 0.5;
                const delay = exponentialDelay + jitter;
                this.logger.error(
                    `Failed network call (${e}), retrying in ${Math.round(delay)}ms (attempt ${attempt})`
                );
                await sleep(delay);
            }
        }
    }
}
