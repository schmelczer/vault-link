import type {
	DocumentId,
	RelativePath,
	VaultUpdateId
} from "../persistence/database";

import type { Logger } from "../tracing/logger";
import type { Settings } from "../persistence/settings";
import type { FetchController } from "./fetch-controller";
import { sleep } from "../utils/sleep";
import { SyncResetError } from "./sync-reset-error";
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

	private static formatError(error: SerializedError): string {
		let result = error.message;
		if (error.causes.length > 0) {
			const causes = error.causes.join(", ");
			result += ` caused by: ${causes}`;
		}

		return result;
	}

	public async create({
		documentId,
		relativePath,
		contentBytes
	}: {
		documentId?: DocumentId;
		relativePath: RelativePath;
		contentBytes: Uint8Array;
	}): Promise<DocumentVersionWithoutContent> {
		return this.retryForever(async () => {
			const formData = new FormData();
			if (documentId !== undefined) {
				formData.append("document_id", documentId);
			}
			formData.append("relative_path", relativePath);
			formData.append(
				"content",
				new Blob([new Uint8Array(contentBytes)])
			);

			const response = await this.client(this.getUrl("/documents"), {
				method: "POST",
				body: formData,
				headers: this.getDefaultHeaders()
			});

			const result: SerializedError | DocumentVersionWithoutContent =
				(await response.json()) as  // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
				| SerializedError
				| DocumentVersionWithoutContent;

			if ("errorType" in result) {
				throw new Error(
					`Failed to create document: ${SyncService.formatError(result)}`
				);
			}

			this.logger.debug(
				`Created document ${JSON.stringify(result)} with id ${result.documentId
				}`
			);

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
				`Updating text document ${documentId} with parent version ${parentVersionId} and relative path ${relativePath}`
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

			const result: SerializedError | DocumentUpdateResponse =
				(await response.json()) as  // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
				| SerializedError
				| DocumentUpdateResponse;

			if ("errorType" in result) {
				throw new Error(
					`Failed to update document: ${SyncService.formatError(result)}`
				);
			}

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

			const result: SerializedError | DocumentUpdateResponse =
				(await response.json()) as  // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
				| SerializedError
				| DocumentUpdateResponse;

			if ("errorType" in result) {
				throw new Error(
					`Failed to update document: ${SyncService.formatError(result)}`
				);
			}

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
			const request: DeleteDocumentVersion = {
				relativePath
			};
			const response = await this.client(
				this.getUrl(`/documents/${documentId}`),
				{
					method: "DELETE",
					body: JSON.stringify(request),
					headers: this.getDefaultHeaders({ type: "json" })
				}
			);

			const result: SerializedError | DocumentVersionWithoutContent =
				(await response.json()) as  // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
				| SerializedError
				| DocumentVersionWithoutContent;

			if ("errorType" in result) {
				throw new Error(
					`Failed to delete document: ${SyncService.formatError(result)}`
				);
			}

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
			const response = await this.client(
				this.getUrl(`/documents/${documentId}`),
				{
					headers: this.getDefaultHeaders()
				}
			);

			const result: SerializedError | DocumentVersion =
				(await response.json()) as SerializedError | DocumentVersion; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

			if ("errorType" in result) {
				throw new Error(
					`Failed to get document: ${SyncService.formatError(result)}`
				);
			}

			this.logger.debug(
				`Get document ${result.relativePath} with id ${result.documentId}`
			);

			return result;
		});
	}

	public async getAll(
		since?: VaultUpdateId
	): Promise<FetchLatestDocumentsResponse> {
		return this.retryForever(async () => {
			const url = new URL(this.getUrl("/documents"));
			if (since !== undefined) {
				url.searchParams.append("since", since.toString());
			}
			const response = await this.client(url.toString(), {
				headers: this.getDefaultHeaders()
			});

			const result: SerializedError | FetchLatestDocumentsResponse =
				(await response.json()) as  // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
				| SerializedError
				| FetchLatestDocumentsResponse;

			if ("errorType" in result) {
				throw new Error(
					`Failed to get documents: ${SyncService.formatError(result)}`
				);
			}

			this.logger.debug(
				`Got ${result.latestDocuments.length} document metadata`
			);

			return result;
		});
	}

	public async ping(): Promise<PingResponse> {
		const response = await this.pingClient(this.getUrl("/ping"), {
			headers: this.getDefaultHeaders()
		});
		const result: PingResponse | SerializedError =
			(await response.json()) as PingResponse | SerializedError; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

		if ("errorType" in result) {
			throw new Error(
				`Failed to ping server: ${SyncService.formatError(result)}`
			);
		}

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
		// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
		while (true) {
			try {
				return await fn();
			} catch (e) {
				// We must not retry errors coming from reset
				if (e instanceof SyncResetError) {
					throw e;
				}

				const retryInterval =
					this.settings.getSettings().networkRetryIntervalMs;
				this.logger.error(
					`Failed network call (${e}), retrying in ${retryInterval}ms`
				);
				await sleep(retryInterval);
			}
		}
	}
}
