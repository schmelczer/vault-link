export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface DocumentMetadata {
	parentVersionId: VaultUpdateId;
	documentId: DocumentId;
	hash: string;
	isDeleted: boolean;
}

import type { Logger } from "src/tracing/logger";

export interface StoredDatabase {
	documents: Record<RelativePath, DocumentMetadata>;
	lastSeenUpdateId: VaultUpdateId | undefined;
}

export class Database {
	private documents = new Map<
		RelativePath,
		DocumentMetadata | Promise<DocumentMetadata | undefined>
	>();

	private lastSeenUpdateId: VaultUpdateId | undefined;

	public constructor(
		private readonly logger: Logger,
		initialState: Partial<StoredDatabase> | undefined,
		private readonly saveData: (data: StoredDatabase) => Promise<void>
	) {
		initialState ??= {};
		if (initialState.documents) {
			for (const [relativePath, metadata] of Object.entries(
				initialState.documents
			)) {
				this.documents.set(relativePath, metadata);
			}
		}
		this.ensureConsistency();

		this.logger.debug(`Loaded ${this.documents.size} documents`);

		this.lastSeenUpdateId = initialState.lastSeenUpdateId;
		this.logger.debug(
			`Loaded last seen update id: ${this.lastSeenUpdateId}`
		);
	}

	public get length(): number {
		return this.documents.size;
	}

	public get resolvedDocuments(): [RelativePath, DocumentMetadata][] {
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		return Array.from(this.documents.entries()).filter(
			([_, metadata]) => !(metadata instanceof Promise)
		) as [RelativePath, DocumentMetadata][];
	}

	public getLastSeenUpdateId(): VaultUpdateId | undefined {
		return this.lastSeenUpdateId;
	}

	public async setLastSeenUpdateId(
		value: VaultUpdateId | undefined
	): Promise<void> {
		this.lastSeenUpdateId = value;
		await this.save();
	}

	public async resetSyncState(): Promise<void> {
		this.documents = new Map();
		this.lastSeenUpdateId = 0;
		await this.save();
	}

	public getDocumentByDocumentId(
		documentId: DocumentId
	): [RelativePath, DocumentMetadata] | undefined {
		return this.resolvedDocuments.find(
			([_, metadata]) => metadata.documentId === documentId
		);
	}

	public getDocumentByIdentity(
		document:
			| DocumentMetadata
			| Promise<DocumentMetadata | undefined>
			| undefined
	):
		| [
				RelativePath,
				DocumentMetadata | Promise<DocumentMetadata | undefined>
		  ]
		| undefined {
		if (document === undefined) {
			return undefined;
		}

		return Array.from(this.documents.entries()).find(
			([_, metadata]) => metadata === document
		);
	}

	public async setDocument({
		documentId,
		relativePath,
		parentVersionId,
		hash,
		isDeleted
	}: {
		documentId: DocumentId;
		relativePath: RelativePath;
		parentVersionId: VaultUpdateId;
		hash: string;
		isDeleted: boolean;
	}): Promise<void> {
		this.documents.set(relativePath, {
			documentId,
			parentVersionId,
			hash,
			isDeleted
		});
		await this.save();
	}

	public async setDocumentPromise({
		relativePath,
		promise
	}: {
		relativePath: RelativePath;
		promise: Promise<DocumentMetadata | undefined>;
	}): Promise<void> {
		this.documents.set(relativePath, promise);
		// No need to save as Promises don't get serialized
		// and a crash would only result in the document being
		// creatied again.
	}

	public getResolvedDocument(
		relativePath: RelativePath | undefined
	): DocumentMetadata | undefined {
		if (relativePath == undefined) {
			return undefined;
		}

		const metadata = this.documents.get(relativePath);
		if (metadata instanceof Promise) {
			return undefined;
		}

		return metadata;
	}

	public getDocument(
		relativePath: RelativePath | undefined
	): Promise<DocumentMetadata | undefined> | DocumentMetadata | undefined {
		if (relativePath == undefined) {
			return undefined;
		}

		return this.documents.get(relativePath);
	}

	public async move(
		oldRelativePath: RelativePath,
		newRelativePath: RelativePath
	): Promise<void> {
		const document = this.documents.get(oldRelativePath);
		if (!document) {
			return;
		}

		const resolvedDocument = this.getResolvedDocument(oldRelativePath);
		if (
			this.documents.has(newRelativePath) &&
			resolvedDocument != undefined &&
			resolvedDocument.isDeleted
		) {
			throw new Error(
				`Cannot update physical path to path that is already in use: ${newRelativePath}`
			);
		}

		this.documents.delete(oldRelativePath);
		this.documents.set(newRelativePath, document);

		await this.save();
	}

	private async save(): Promise<void> {
		this.ensureConsistency();
		await this.saveData({
			documents: Object.fromEntries(this.resolvedDocuments),
			lastSeenUpdateId: this.lastSeenUpdateId
		});
	}

	private ensureConsistency(): void {
		const idToPath = new Map<string, string[]>();

		this.resolvedDocuments.forEach(([name, metadata]) => {
			idToPath.set(metadata.documentId, [
				...(idToPath.get(metadata.documentId) ?? []),
				name
			]);
		});

		const duplicates = Array.from(idToPath.entries())
			.filter(([_, paths]) => paths.length > 1)
			.map(([id, paths]) => `${id} (${paths.join(", ")})`);

		if (duplicates.length > 0) {
			throw new Error(
				"Document IDs are not unique, found duplicates: " +
					duplicates.join("; ")
			);
		}
	}
}
