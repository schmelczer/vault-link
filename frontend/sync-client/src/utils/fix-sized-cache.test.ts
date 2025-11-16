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
});
