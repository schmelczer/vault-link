import type { Logger } from "../tracing/logger";

export type VaultUpdateId = number;
export type DocumentId = string;
export type RelativePath = string;

export interface DocumentMetadata {
	parentVersionId: VaultUpdateId;
	documentId: DocumentId;
	hash: string;
}

export interface StoredDocumentMetadata {
	relativePath: RelativePath;
	parentVersionId: VaultUpdateId;
	documentId: DocumentId;
	hash: string;
}

export interface StoredDatabase {
	documents: StoredDocumentMetadata[];
	lastSeenUpdateId: VaultUpdateId | undefined;
}

export interface DocumentRecord {
	identity: symbol;
	relativePath: RelativePath;
	metadata: DocumentMetadata | undefined;
	isDeleted: boolean;
	updates: Promise<void>[];
	parallelVersion: number;
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
				isDeleted: false,
				updates: [],
				parallelVersion: 0
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
		const paths = new Map<string, DocumentRecord[]>();
		this.documents
			.filter(({ metadata }) => metadata !== undefined)
			.forEach((record) =>
				paths.set(record.relativePath, [
					record,
					...(paths.get(record.relativePath) ?? [])
				])
			);

		return Array.from(paths.values()).map((records) => {
			records.sort(
				(a, b) => b.parallelVersion - a.parallelVersion // descending
			);

			if (
				records.length > 1 &&
				records.some((current, i) =>
					i === 0
						? false
						: records[i - 1].parallelVersion ===
							current.parallelVersion
				)
			) {
				throw new Error(
					`Multiple documents with the same parallel version and path at ${records[0].relativePath}`
				);
			}
			return records[0];
		});
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

	public setDocument(
		{
			documentId,
			relativePath,
			parentVersionId,
			hash
		}: {
			documentId: DocumentId;
			relativePath: RelativePath;
			parentVersionId: VaultUpdateId;
			hash: string;
		},
		identity?: symbol
	): void {
		let entry: DocumentRecord | undefined;
		if (identity !== undefined) {
			const entry = this.getDocumentByIdentity(identity);

			this.documents = this.documents.filter(
				({ identity }) => identity !== entry.identity
			);

			this.documents.push({
				...entry,
				relativePath,
				metadata: {
					documentId,
					parentVersionId,
					hash
				}
			});

			this.save();
			return;
		}

		// We find a match based on relative path and we find one with a different document id
		// meaning that two documents occupy the same path in terms of in-flight requests so we
		// need to create a new parallel version.
		entry = this.getLatestDocumentByRelativePath(relativePath);
		if (entry && entry.metadata?.documentId !== documentId) {
			this.documents.push({
				// `entry` might be undefined if the document is new
				identity: Symbol(),
				relativePath,
				metadata: {
					documentId,
					parentVersionId,
					hash
				},
				isDeleted: false,
				updates: [],
				parallelVersion: entry.parallelVersion + 1
			});
			this.save();
			return;
		}

		this.documents.push({
			identity: Symbol(),
			relativePath,
			metadata: {
				documentId,
				parentVersionId,
				hash
			},
			isDeleted: false,
			updates: [],
			parallelVersion: 0
		});

		this.save();
	}

	public removeDocumentPromise(promise: Promise<void>): void {
		const entry = this.getDocumentByUpdatePromise(promise);
		entry.updates = entry.updates.filter((update) => update !== promise);
		// No need to save as Promises don't get serialized
	}

	public getLatestDocumentByRelativePath(
		find: RelativePath
	): DocumentRecord | undefined {
		const candidates = this.documents.filter(
			({ relativePath }) => relativePath === find
		);
		candidates.sort((a, b) => b.parallelVersion - a.parallelVersion); // descending
		return candidates[0];
	}

	public async getResolvedDocumentByRelativePath(
		relativePath: RelativePath,
		promise: Promise<void>
	): Promise<void> {
		let entry = this.getLatestDocumentByRelativePath(relativePath);

		if (entry === undefined) {
			entry = {
				relativePath,
				identity: Symbol(),
				metadata: undefined,
				isDeleted: false,
				updates: [],
				parallelVersion: 0
			};

			this.documents.push(entry);
		}

		const currentPromises = entry.updates;
		entry.updates = [...currentPromises, promise];
		await Promise.all(currentPromises);
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
		const oldDocument =
			this.getLatestDocumentByRelativePath(oldRelativePath);
		if (oldDocument === undefined) {
			// We can try moving a non-existent document if it hasn't yet got created becasue it's
			// the result of an offline event while this move happens online before.
			return;
		}

		this.documents = this.documents.filter(
			({ identity }) => identity !== oldDocument.identity
		);

		let newDocument = this.getLatestDocumentByRelativePath(newRelativePath);

		// It's either an invalid state of newDocument is pending deletion and we have to wait for it to complete
		this.documents.push({
			identity: oldDocument.identity,
			metadata: oldDocument.metadata,
			relativePath: newRelativePath,
			isDeleted: oldDocument.isDeleted,
			updates: oldDocument.updates,
			// We're in a strange state where the target of the move has just got deleted,
			// however, its metadata might already have a bunch of updates queued up for
			// the document at the new location. We need to keep these updates.
			parallelVersion:
				newDocument !== undefined ? newDocument.parallelVersion + 1 : 0
		});

		this.save();
	}

	public delete(relativePath: RelativePath): void {
		const candidate = this.getLatestDocumentByRelativePath(relativePath);
		if (candidate === undefined) {
			// it's fine because the document to be deleted might not have been created yet
			return;
		}
		candidate.isDeleted = true;
	}

	private save(): void {
		this.logger.debug(JSON.stringify(this.documents, null, 2));

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
