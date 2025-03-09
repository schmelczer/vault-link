import type { Logger } from "../tracing/logger";

export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface DocumentMetadata {
	parentVersionId: VaultUpdateId;
	documentId: DocumentId;
	hash: string;
	isDeleted: boolean;
}
export interface StoredDocumentMetadata {
	relativePath: RelativePath;
	parentVersionId: VaultUpdateId;
	documentId: DocumentId;
	hash: string;
	isDeleted: boolean;
}

export interface StoredDatabase {
	documents: StoredDocumentMetadata[];
	lastSeenUpdateId: VaultUpdateId | undefined;
}

export interface DocumentRecord {
	identity: symbol;
	relativePath: RelativePath;
	metadata: DocumentMetadata | undefined;
	updates: Promise<void>[];
}

export class Database {
	private documents: DocumentRecord[];
	private lastSeenUpdateId: VaultUpdateId | undefined;

	public constructor(
		private readonly logger: Logger,
		initialState: Partial<StoredDatabase> | undefined,
		private readonly saveData: (data: StoredDatabase) => Promise<void>
	) {
		initialState ??= {};

		this.documents =
			initialState.documents?.map(({ relativePath, ...metadata }) => ({
				relativePath,
				identity: Symbol(),
				metadata,
				updates: []
			})) ?? [];

		this.ensureConsistency();
		this.logger.debug(`Loaded ${this.documents.length} documents`);

		this.lastSeenUpdateId = initialState.lastSeenUpdateId;
		this.logger.debug(
			`Loaded last seen update id: ${this.lastSeenUpdateId}`
		);
	}

	public get length(): number {
		return this.documents.length;
	}

	public get resolvedDocuments(): DocumentRecord[] {
		return this.documents.filter(({ metadata }) => metadata !== undefined);
	}

	public getLastSeenUpdateId(): VaultUpdateId | undefined {
		return this.lastSeenUpdateId;
	}

	public setLastSeenUpdateId(value: VaultUpdateId | undefined): void {
		this.lastSeenUpdateId = value;
		this.save();
	}

	public resetSyncState(): void {
		this.documents = [];
		this.lastSeenUpdateId = 0;
		this.save();
	}

	public setDocument({
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
	}): void {
		const entry = this.getDocumentByRelativePath(relativePath);

		if (entry !== undefined) {
			this.documents = this.documents.filter(
				({ identity }) => identity !== entry.identity
			);
		}

		this.documents.push({
			// `entry` might be undefined if the document is new
			identity: entry?.identity ?? Symbol(),
			relativePath,
			metadata: {
				documentId,
				parentVersionId,
				hash,
				isDeleted
			},
			updates: entry?.updates ?? []
		});

		this.save();
	}

	public removeDocumentPromise(promise: Promise<void>): void {
		const entry = this.getDocumentByUpdatePromise(promise);
		entry.updates = entry.updates.filter((update) => update !== promise);
		// No need to save as Promises don't get serialized
	}

	public getDocumentByRelativePath(
		find: RelativePath
	): DocumentRecord | undefined {
		return this.documents.find(({ relativePath }) => relativePath === find);
	}

	public async getResolvedDocumentByRelativePath(
		relativePath: RelativePath,
		promise: Promise<void>
	): Promise<DocumentRecord> {
		let entry = this.getDocumentByRelativePath(relativePath);

		if (entry === undefined) {
			entry = {
				relativePath,
				identity: Symbol(),
				metadata: undefined,
				updates: []
			};

			this.documents.push(entry);
		}

		const currentPromises = entry.updates;
		entry.updates = [...currentPromises, promise];
		await Promise.all(currentPromises);

		// Refetch the document as it might have been updated
		return this.getDocumentByIdentity(entry.identity);
	}

	public getDocumentByUpdatePromise(promise: Promise<void>): DocumentRecord {
		const result = this.documents.find(({ updates }) =>
			updates.includes(promise)
		);

		if (result === undefined) {
			throw new Error("Document not found by update promise");
		}

		return result;
	}

	public getDocumentByDocumentId(
		documentId: DocumentId
	): DocumentRecord | undefined {
		return this.documents.find(
			({ metadata }) => metadata?.documentId === documentId
		);
	}

	public getDocumentByIdentity(find: symbol): DocumentRecord {
		const result = this.documents.find(({ identity }) => identity === find);

		if (result === undefined) {
			throw new Error("Document not found by identity symbol");
		}

		return result;
	}

	public move(
		oldRelativePath: RelativePath,
		newRelativePath: RelativePath
	): void {
		const oldDocument = this.getDocumentByRelativePath(oldRelativePath);
		if (oldDocument === undefined) {
			throw new Error(
				`Document to be moved not found: ${oldRelativePath}`
			);
		}

		const newDocument = this.getDocumentByRelativePath(newRelativePath);
		if (
			newDocument !== undefined &&
			newDocument.metadata?.isDeleted === false
		) {
			throw new Error(
				`Cannot move document to existing path: ${newRelativePath}`
			);
		}

		this.documents = this.documents.filter(
			({ identity }) =>
				identity !== oldDocument.identity &&
				identity !== newDocument?.identity
		);

		this.documents.push({
			...oldDocument,
			relativePath: newRelativePath
		});

		this.save();
	}

	private save(): void {
		this.ensureConsistency();
		void this.saveData({
			documents: this.resolvedDocuments.map(
				({ relativePath, metadata }) => ({
					relativePath,
					...metadata
				})
			) as StoredDocumentMetadata[],
			lastSeenUpdateId: this.lastSeenUpdateId
		});
	}

	private ensureConsistency(): void {
		const idToPath = new Map<string, string[]>();

		this.resolvedDocuments
			.filter(({ metadata }) => metadata !== undefined)
			.forEach(({ metadata, relativePath }) => {
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				idToPath.set(metadata!.documentId, [
					// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
					...(idToPath.get(metadata!.documentId) ?? []),
					relativePath
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
