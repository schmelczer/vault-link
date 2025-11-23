// Implements an in-memory fixed-size cache for document contents,

import type { VaultUpdateId } from "../../persistence/database";

// Doubly-linked list node for O(1) LRU operations
class LRUNode {
	public constructor(
		public key: VaultUpdateId,
		public value: Uint8Array,
		public prev: LRUNode | null = null,
		public next: LRUNode | null = null
	) {}
}

// evicting the least recently used documents when the size limit is exceeded.
export class FixedSizeDocumentCache {
	private currentSizeInBytes: number;
	private readonly cache: Map<VaultUpdateId, LRUNode>;
	private head: LRUNode | null; // Least recently used
	private tail: LRUNode | null; // Most recently used

	public constructor(private maxSizeInBytes: number) {
		this.currentSizeInBytes = 0;
		this.cache = new Map();
		this.head = null;
		this.tail = null;
	}

	public get(updateId: VaultUpdateId): Uint8Array | undefined {
		const node = this.cache.get(updateId);
		if (node) {
			this.moveToTail(node);
			return node.value;
		}

		return undefined;
	}

	public put(updateId: VaultUpdateId, content: Uint8Array): void {
		if (content.byteLength > this.maxSizeInBytes) {
			// Document is too large to fit in the cache
			return;
		}

		// If the document is already in the cache, update it
		const existingNode = this.cache.get(updateId);
		if (existingNode != null) {
			this.currentSizeInBytes -= existingNode.value.byteLength;
			this.removeNode(existingNode);
			this.cache.delete(updateId);
		}

		const newNode = new LRUNode(updateId, content);
		this.cache.set(updateId, newNode);
		this.addToTail(newNode);
		this.currentSizeInBytes += content.byteLength;
		this.fitBelowMaxSize();
	}

	public reset(): void {
		this.cache.clear();
		this.head = null;
		this.tail = null;
		this.currentSizeInBytes = 0;
	}

	public resize(newMaxSizeInBytes: number): void {
		this.maxSizeInBytes = newMaxSizeInBytes;
		this.fitBelowMaxSize();
	}

	private fitBelowMaxSize(): void {
		// Evict least recently used documents if over size limit
		while (this.currentSizeInBytes > this.maxSizeInBytes && this.head) {
			const lruNode = this.head;
			this.removeNode(lruNode);
			this.cache.delete(lruNode.key);
			this.currentSizeInBytes -= lruNode.value.byteLength;
		}
	}

	private removeNode(node: LRUNode): void {
		if (node.prev) {
			node.prev.next = node.next;
		} else {
			this.head = node.next;
		}

		if (node.next) {
			node.next.prev = node.prev;
		} else {
			this.tail = node.prev;
		}

		node.prev = null;
		node.next = null;
	}

	private addToTail(node: LRUNode): void {
		node.prev = this.tail;
		node.next = null;

		if (this.tail) {
			this.tail.next = node;
		}

		this.tail = node;

		this.head ??= node;
	}

	private moveToTail(node: LRUNode): void {
		if (node === this.tail) {
			return;
		}
		this.removeNode(node);
		this.addToTail(node);
	}
}
