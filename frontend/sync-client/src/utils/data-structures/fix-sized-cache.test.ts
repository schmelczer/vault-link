import { describe, it } from "node:test";
import assert from "node:assert";
import { FixedSizeDocumentCache } from "./fix-sized-cache";

describe("fixedSizeDocumentCache", () => {
	it("happyPath", async () => {
		const cache = new FixedSizeDocumentCache(4);
		const doc1 = new Uint8Array([1, 2]);
		const doc2 = new Uint8Array([3, 4]);
		const doc3 = new Uint8Array([5, 6]);

		cache.put(1, doc1);
		assert.equal(cache.get(1), doc1);
		cache.put(2, doc2);
		assert.equal(cache.get(1), doc1);
		assert.equal(cache.get(2), doc2);
		cache.put(3, doc3);
		assert.equal(cache.get(1), undefined);
		assert.equal(cache.get(2), doc2);
		assert.equal(cache.get(3), doc3);
	});

	it("updateExistingEntry", async () => {
		const cache = new FixedSizeDocumentCache(4);
		const doc1_v1 = new Uint8Array([1, 2]);
		const doc1_v2 = new Uint8Array([3, 4]);
		const doc2 = new Uint8Array([5, 6]);

		cache.put(1, doc1_v1);
		assert.equal(cache.get(1), doc1_v1);
		cache.put(2, doc2);
		assert.equal(cache.get(1), doc1_v1);
		assert.equal(cache.get(2), doc2);
		cache.put(1, doc1_v2); // Update doc1
		assert.equal(cache.get(1), doc1_v2);
		assert.equal(cache.get(2), doc2);
	});

	it("evictOldestEntry", async () => {
		const cache = new FixedSizeDocumentCache(4);
		const doc1 = new Uint8Array([1, 2]);
		const doc2 = new Uint8Array([3, 4]);
		const doc3 = new Uint8Array([5, 6]);

		cache.put(1, doc1);
		cache.put(2, doc2);
		assert.equal(cache.get(2), doc2);
		assert.equal(cache.get(1), doc1);
		cache.put(3, doc3);
		assert.equal(cache.get(1), doc1);
		assert.equal(cache.get(2), undefined);
		assert.equal(cache.get(3), doc3);
	});

	it("tooLargeEntry", async () => {
		const cache = new FixedSizeDocumentCache(2);
		const doc1 = new Uint8Array([1, 2, 3]);

		cache.put(1, doc1);
		assert.equal(cache.get(1), undefined);
	});

	it("multipleEvictionsInSinglePut", async () => {
		const cache = new FixedSizeDocumentCache(10);
		const doc1 = new Uint8Array([1, 2]);
		const doc2 = new Uint8Array([3, 4]);
		const doc3 = new Uint8Array([5, 6]);
		const doc4 = new Uint8Array([7, 8, 9, 10, 11, 12, 13, 14]); // 8 bytes

		cache.put(1, doc1);
		cache.put(2, doc2);
		cache.put(3, doc3);
		// Cache now has 6 bytes total

		cache.put(4, doc4); // Should evict doc1 and doc2 to make room (total: 2+8=10)
		assert.equal(cache.get(1), undefined); // Evicted
		assert.equal(cache.get(2), undefined); // Evicted
		assert.equal(cache.get(3), doc3); // Still present
		assert.equal(cache.get(4), doc4);
	});

	it("clearCache", async () => {
		const cache = new FixedSizeDocumentCache(10);
		const doc1 = new Uint8Array([1, 2]);
		const doc2 = new Uint8Array([3, 4]);

		cache.put(1, doc1);
		cache.put(2, doc2);
		assert.equal(cache.get(1), doc1);
		assert.equal(cache.get(2), doc2);

		cache.reset();
		assert.equal(cache.get(1), undefined);
		assert.equal(cache.get(2), undefined);

		// Should be able to add entries after clear
		cache.put(3, doc1);
		assert.equal(cache.get(3), doc1);
	});

	it("getNonExistentKey", async () => {
		const cache = new FixedSizeDocumentCache(10);
		const doc1 = new Uint8Array([1, 2]);
		cache.put(1, doc1);
		assert.equal(cache.get(999), undefined);
	});

	it("updateEntryWithDifferentSizeTriggeringEviction", async () => {
		const cache = new FixedSizeDocumentCache(6);
		const doc1_v1 = new Uint8Array([1, 2]);
		const doc1_v2 = new Uint8Array([1, 2, 3, 4]); // Larger version
		const doc2 = new Uint8Array([5, 6]);
		const doc3 = new Uint8Array([7, 8]);

		cache.put(1, doc1_v1);
		cache.put(2, doc2);
		cache.put(3, doc3);

		// Update doc1 with larger version, should evict doc2
		cache.put(1, doc1_v2);

		assert.equal(cache.get(1), doc1_v2);
		assert.equal(cache.get(2), undefined); // Evicted
		assert.equal(cache.get(3), doc3);
	});

	it("singleItemCache", async () => {
		const cache = new FixedSizeDocumentCache(2);
		const doc1 = new Uint8Array([1, 2]);
		const doc2 = new Uint8Array([3, 4]);

		cache.put(1, doc1);
		assert.equal(cache.get(1), doc1);

		cache.put(2, doc2);
		assert.equal(cache.get(1), undefined); // Evicted
		assert.equal(cache.get(2), doc2);
	});

	it("multipleGetsOnSameEntry", async () => {
		const cache = new FixedSizeDocumentCache(4);
		const doc1 = new Uint8Array([1, 2]);
		const doc2 = new Uint8Array([3, 4]);
		const doc3 = new Uint8Array([5, 6]);

		cache.put(1, doc1);
		cache.put(2, doc2);

		// Multiple gets on doc1
		cache.get(1);
		cache.get(1);
		cache.get(1);

		// Order should be: 2 (LRU), 1 (MRU)
		cache.put(3, doc3);

		assert.equal(cache.get(1), doc1);
		assert.equal(cache.get(2), undefined); // Evicted
		assert.equal(cache.get(3), doc3);
	});

	it("exactlySizedEntry", async () => {
		const cache = new FixedSizeDocumentCache(4);
		const doc1 = new Uint8Array([1, 2, 3, 4]); // Exactly cache size

		cache.put(1, doc1);
		assert.equal(cache.get(1), doc1);

		const doc2 = new Uint8Array([5, 6]);
		cache.put(2, doc2);

		// doc1 should be evicted to make room for doc2
		assert.equal(cache.get(1), undefined);
		assert.equal(cache.get(2), doc2);
	});

	it("updateEntryMakesItMostRecent", async () => {
		const cache = new FixedSizeDocumentCache(6);
		const doc1_v1 = new Uint8Array([1, 2]);
		const doc1_v2 = new Uint8Array([3, 4]);
		const doc2 = new Uint8Array([5, 6]);
		const doc3 = new Uint8Array([7, 8]);
		const doc4 = new Uint8Array([9, 10]);

		cache.put(1, doc1_v1);
		cache.put(2, doc2);
		cache.put(3, doc3);

		// Update doc1 (should move it to most recent)
		cache.put(1, doc1_v2);

		// Order should be: 2 (LRU), 3, 1 (MRU)
		// Adding doc4 should evict doc2
		cache.put(4, doc4);

		assert.equal(cache.get(1), doc1_v2);
		assert.equal(cache.get(2), undefined); // Evicted
		assert.equal(cache.get(3), doc3);
		assert.equal(cache.get(4), doc4);
	});

	it("alternatingAccessPattern", async () => {
		const cache = new FixedSizeDocumentCache(4);
		const doc1 = new Uint8Array([1, 2]);
		const doc2 = new Uint8Array([3, 4]);
		const doc3 = new Uint8Array([5, 6]);

		cache.put(1, doc1);
		cache.put(2, doc2);

		// Alternate access between doc1 and doc2
		cache.get(1);
		cache.get(2);
		cache.get(1);
		cache.get(2);

		// Order should be: 1, 2 (MRU)
		cache.put(3, doc3);

		assert.equal(cache.get(1), undefined); // Evicted
		assert.equal(cache.get(2), doc2);
		assert.equal(cache.get(3), doc3);
	});

	it("zeroByteDocs", async () => {
		const cache = new FixedSizeDocumentCache(2);
		const doc1 = new Uint8Array([]);
		const doc2 = new Uint8Array([]);
		const doc3 = new Uint8Array([1, 2]);

		cache.put(1, doc1);
		cache.put(2, doc2);
		cache.put(3, doc3);

		assert.equal(cache.get(1), doc1);
		assert.equal(cache.get(2), doc2);
		assert.equal(cache.get(3), doc3);
	});

	it("resizeToLargerSizeNoEviction", async () => {
		const cache = new FixedSizeDocumentCache(4);
		const doc1 = new Uint8Array([1, 2]);
		const doc2 = new Uint8Array([3, 4]);

		cache.put(1, doc1);
		cache.put(2, doc2);

		cache.resize(10);

		assert.equal(cache.get(1), doc1);
		assert.equal(cache.get(2), doc2);
	});

	it("resizeCausesMultipleEvictions", async () => {
		const cache = new FixedSizeDocumentCache(10);
		const doc1 = new Uint8Array([1, 2]);
		const doc2 = new Uint8Array([3, 4]);
		const doc3 = new Uint8Array([5, 6]);
		const doc4 = new Uint8Array([7, 8]);

		cache.put(1, doc1);
		cache.put(2, doc2);
		cache.put(3, doc3);
		cache.put(4, doc4);
		// Cache has 8 bytes total

		cache.resize(2);

		// Should evict doc1, doc2, doc3 to get down to 2 bytes
		assert.equal(cache.get(1), undefined);
		assert.equal(cache.get(2), undefined);
		assert.equal(cache.get(3), undefined);
		assert.equal(cache.get(4), doc4);
	});
});
