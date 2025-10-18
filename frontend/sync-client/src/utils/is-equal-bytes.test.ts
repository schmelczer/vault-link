import { describe, it } from "node:test";
import assert from "node:assert";
import { isEqualBytes } from "./is-equal-bytes";

describe("isEqualBytes", () => {
	it("should return true for equal byte arrays", () => {
		const bytes1 = new Uint8Array([1, 2, 3, 4]);
		const bytes2 = new Uint8Array([1, 2, 3, 4]);
		assert.strictEqual(isEqualBytes(bytes1, bytes2), true);
	});

	it("should return false for byte arrays of different lengths", () => {
		const bytes1 = new Uint8Array([1, 2, 3, 4]);
		const bytes2 = new Uint8Array([1, 2, 3]);
		assert.strictEqual(isEqualBytes(bytes1, bytes2), false);
	});

	it("should return true for empty byte arrays", () => {
		const bytes1 = new Uint8Array([]);
		const bytes2 = new Uint8Array([]);
		assert.strictEqual(isEqualBytes(bytes1, bytes2), true);
	});

	it("should return false for byte arrays with same length but different content", () => {
		const bytes1 = new Uint8Array([1, 2, 3, 4]);
		const bytes2 = new Uint8Array([4, 3, 2, 1]);
		assert.strictEqual(isEqualBytes(bytes1, bytes2), false);
	});
});
