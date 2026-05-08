import type {
    DocumentId,
    RelativePath,
    VaultUpdateId
} from "../sync-operations/types";

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
import type { UpdateTextDocumentVersion } from "./types/UpdateTextDocumentVersion";
import { buildVaultUrl } from "./build-vault-url";

export class SyncService {
    private readonly client: typeof globalThis.fetch;
    private readonly pingClient: typeof globalThis.fetch;
    private isStopped = false;

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
            const result: SerializedError =
                (await response.json()) as SerializedError; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
            return SyncService.formatError(result);
        }
        return `HTTP ${response.status}: ${response.statusText}`;
    }

    private static formatError(error: SerializedError): string {
        let result = error.message;
        if (error.causes.length > 0) {
            const causes = error.causes.join(", ");
            result += ` caused by: ${causes}`;
        }

        return result;
    }

    private static async throwIfNotOk(
        response: Response,
        operation: string
    ): Promise<void> {
        if (response.ok) {
            return;
        }
        const message = `Failed to ${operation}: ${await SyncService.errorFromResponse(response)}`;
        // 429 is the only 4xx the server uses for *transient* contention
        // (`WriteBusyError` → HTTP 429). Every other 4xx means the request
        // is permanently rejected and shouldn't be retried.
        if (response.status === 429) {
            throw new Error(message);
        }
        if (response.status >= 400 && response.status < 500) {
            throw new HttpClientError(response.status, message);
        }
        throw new Error(message);
    }

    /**
     * Signal that the service is shutting down so any in-flight
     * `retryForever` exits at its next iteration instead of looping
     * indefinitely after the rest of the client has stopped. Idempotent.
     */
    public stop(): void {
        this.isStopped = true;
    }

    /**
     * Re-enable the service after a `stop()`. Used when the client pauses
     * and resumes syncing within the same lifecycle (e.g. user toggles
     * sync off and on).
     */
    public resume(): void {
        this.isStopped = false;
    }

    public async create({
        relativePath,
        lastSeenVaultUpdateId,
        contentBytes
    }: {
        relativePath: RelativePath;
        lastSeenVaultUpdateId: VaultUpdateId;
        contentBytes: Uint8Array;
    }): Promise<DocumentUpdateResponse> {
        return this.retryForever(async () => {
            const formData = new FormData();

            formData.append("relative_path", relativePath);
            formData.append(
                "last_seen_vault_update_id",
                lastSeenVaultUpdateId.toString()
            );
            formData.append(
                "content",
                new Blob([new Uint8Array(contentBytes)])
            );

            this.logger.debug(
                `Creating document with relative path ${relativePath}`
            );

            const response = await this.client(this.getUrl("/documents"), {
                method: "POST",
                body: formData,
                headers: this.getDefaultHeaders()
            });

            await SyncService.throwIfNotOk(response, "create document");

            const result: DocumentUpdateResponse =
                (await response.json()) as DocumentUpdateResponse; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

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
        relativePath: RelativePath | undefined;
        content: (number | string)[];
    }): Promise<DocumentUpdateResponse> {
        return this.retryForever(async () => {
            this.logger.debug(
                `Updating text document ${documentId} with parent version ${parentVersionId} and relative path ${relativePath ?? "<unchanged>"}, content [${content.join(", ")}]`
            );

            const request: UpdateTextDocumentVersion = {
                parentVersionId,
                relativePath: relativePath ?? null,
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

            await SyncService.throwIfNotOk(response, "update document");

            const result: DocumentUpdateResponse =
                (await response.json()) as DocumentUpdateResponse; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

            this.logger.debug(
                `Updated document ${JSON.stringify(result)} with id ${
                    result.documentId
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
        relativePath: RelativePath | undefined;
        contentBytes: Uint8Array;
    }): Promise<DocumentUpdateResponse> {
        return this.retryForever(async () => {
            this.logger.debug(
                `Updating binary document ${documentId} with parent version ${parentVersionId} and relative path ${relativePath ?? "<unchanged>"}`
            );
            const formData = new FormData();
            formData.append("parent_version_id", parentVersionId.toString());
            if (relativePath !== undefined) {
                formData.append("relative_path", relativePath);
            }
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

            await SyncService.throwIfNotOk(response, "update document");

            const result: DocumentUpdateResponse =
                (await response.json()) as DocumentUpdateResponse; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

            this.logger.debug(
                `Updated document ${JSON.stringify(result)} with id ${
                    result.documentId
                }}`
            );

            return result;
        });
    }

    public async delete({
        documentId
    }: {
        documentId: DocumentId;
    }): Promise<DocumentVersionWithoutContent> {
        return this.retryForever(async () => {
            this.logger.debug(`Delete document with id ${documentId}`);

            // The server identifies the document by its URL path; no body
            // is needed. Sending one was a leftover of an earlier shape.
            const response = await this.client(
                this.getUrl(`/documents/${documentId}`),
                {
                    method: "DELETE",
                    headers: this.getDefaultHeaders()
                }
            );

            await SyncService.throwIfNotOk(response, "delete document");

            const result: DocumentVersionWithoutContent =
                (await response.json()) as DocumentVersionWithoutContent; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

            this.logger.debug(`Deleted document with id ${documentId}`);

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

            await SyncService.throwIfNotOk(response, "get document");

            const result: DocumentVersion =
                (await response.json()) as DocumentVersion; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

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

            await SyncService.throwIfNotOk(
                response,
                "get document version content"
            );

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
                url.searchParams.append("since_update_id", since.toString());
            }
            const response = await this.client(url.toString(), {
                headers: this.getDefaultHeaders()
            });

            await SyncService.throwIfNotOk(response, "get documents");

            const result: FetchLatestDocumentsResponse =
                (await response.json()) as FetchLatestDocumentsResponse; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

            this.logger.debug(
                `Got ${result.latestDocuments.length} document metadata`
            );

            return result;
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

        const result: PingResponse = (await response.json()) as PingResponse; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

        this.logger.debug(
            `Pinged server, got response: ${JSON.stringify(result)}`
        );

        return result;
    }

    private getUrl(path: string): string {
        return buildVaultUrl(this.settings, path);
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
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        while (true) {
            this.throwIfStopped();
            try {
                return await fn();
            } catch (e) {
                if (
                    e instanceof SyncResetError ||
                    e instanceof HttpClientError
                ) {
                    throw e;
                }
                this.throwIfStopped();

                const retryInterval =
                    this.settings.getSettings().networkRetryIntervalMs;
                this.logger.error(
                    `Failed network call (${e}), retrying in ${retryInterval}ms`
                );
                await sleep(retryInterval);
            }
        }
    }

    private throwIfStopped(): void {
        if (this.isStopped) {
            throw new SyncResetError();
        }
    }
}
