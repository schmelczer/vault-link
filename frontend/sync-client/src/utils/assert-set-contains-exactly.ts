import assert from "node:assert";

export function assertSetContainsExactly<T>(set: Set<T>, ...values: T[]): void {
    assert.ok(
        set.size === values.length &&
            Array.from(set).every((value) => values.includes(value)),
        `Expected set to contain only ${values.map((v) => '"' + v + '"').join(", ")}, but it contained ${Array.from(
            set
        )
            .map((v) => '"' + v + '"')
            .join(", ")}`
    );
}
