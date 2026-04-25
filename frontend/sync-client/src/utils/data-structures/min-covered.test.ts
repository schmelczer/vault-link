import { describe, it } from "node:test";
import assert from "node:assert";
import { MinCovered } from "./min-covered";

describe("MinCovered", () => {
    it("should initialize with the given min value", () => {
        const covered = new MinCovered(5);
        assert.strictEqual(covered.min, 5);
    });

    it("should add values greater than min", () => {
        const covered = new MinCovered(0);
        covered.add(3);
        assert.strictEqual(covered.min, 0);
        covered.add(1);
        assert.strictEqual(covered.min, 1);
        covered.add(4);
        assert.strictEqual(covered.min, 1);
        covered.add(2);
        assert.strictEqual(covered.min, 4);
    });

    it("should ignore duplicate values", () => {
        const covered = new MinCovered(0);
        covered.add(3);
        covered.add(3);
        covered.add(3);
        assert.strictEqual(covered.min, 0);
        covered.add(1);
        covered.add(2);
        assert.strictEqual(covered.min, 3);
    });

    it("should handle multiple consecutive values", () => {
        const covered = new MinCovered(132);
        for (let i = 250; i > 132; i--) {
            assert.strictEqual(covered.min, 132);
            covered.add(i);
        }
        assert.strictEqual(covered.min, 250);
    });

    it("should handle adding values lower than current min", () => {
        const covered = new MinCovered(5);
        covered.add(3);
        assert.strictEqual(covered.min, 5);
        covered.add(6);
        assert.strictEqual(covered.min, 6);
    });

    it("should auto-advance when setting min value", () => {
        const covered = new MinCovered(5);
        covered.add(7);
        covered.add(8);
        covered.add(9);
        assert.strictEqual(covered.min, 5);
        // Setting min to 6 should auto-advance through 7, 8, 9
        covered.min = 6;
        assert.strictEqual(covered.min, 9);
        covered.add(10);
        assert.strictEqual(covered.min, 10);
    });

    it("should handle setting min value with no consecutive values", () => {
        const covered = new MinCovered(5);
        covered.add(10);
        covered.add(15);
        assert.strictEqual(covered.min, 5);
        // Setting min to 8 should not auto-advance (no consecutive values)
        covered.min = 8;
        assert.strictEqual(covered.min, 8);
        // Add 9 to trigger auto-advance to 10
        covered.add(9);
        assert.strictEqual(covered.min, 10);
    });
});
