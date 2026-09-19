import assert from "node:assert/strict";
import { it } from "node:test";
import { packageVersion } from "./package-version";

it("supports direct source imports without webpack globals", async () => {
    assert.strictEqual(packageVersion, "development");
    const { SyncClient } = await import("../sync-client");
    assert.strictEqual(typeof SyncClient.create, "function");
});
