// Implements an in-memory fixed-size cache for document contents,

import type { VaultUpdateId } from "../persistence/database";

// evicting the least recently used documents when the size limit is exceeded.
export class FixedSizeDocumentCache {
	private readonly maxSizeInBytes: number;
	private currentSizeInBytes: number;
	private readonly cache: Map<VaultUpdateId, Uint8Array>;
	private usageOrder: VaultUpdateId[];

	public constructor(maxSizeInBytes: number) {
		this.maxSizeInBytes = maxSizeInBytes;
		this.currentSizeInBytes = 0;
		this.cache = new Map();
		this.usageOrder = [];
	}

	public get(updateId: VaultUpdateId): Uint8Array | undefined {
		const entry = this.cache.get(updateId);
		if (entry) {
			this.usageOrder = this.usageOrder.filter((id) => id !== updateId);
			this.usageOrder.push(updateId);
			return entry;
		}
		return undefined;
	}

	public put(updateId: VaultUpdateId, content: Uint8Array): void {
		if (content.byteLength > this.maxSizeInBytes) {
			// Document is too large to fit in the cache
			return;
		}

		// If the document is already in the cache, update it
		const existingEntry = this.cache.get(updateId);
		if (existingEntry != null) {
			this.currentSizeInBytes -= existingEntry.byteLength;
			this.cache.delete(updateId);
			this.usageOrder = this.usageOrder.filter((id) => id !== updateId);
		}
		this.cache.set(updateId, content);
		this.usageOrder.push(updateId);
		this.currentSizeInBytes += content.byteLength;

		// Evict least recently used documents if over size limit
		while (
			this.currentSizeInBytes > this.maxSizeInBytes &&
			this.usageOrder.length > 0
		) {
			const lruUpdateId = this.usageOrder.shift()!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
			const lruEntry = this.cache.get(lruUpdateId)!; // eslint-disable-line @typescript-eslint/no-non-null-assertion
			this.cache.delete(lruUpdateId);
			this.currentSizeInBytes -= lruEntry.byteLength;
		}
	}

	public clear(): void {
		this.cache.clear();
		this.usageOrder = [];
		this.currentSizeInBytes = 0;
	}
}
