import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
test("a status observer exception must not terminate a background sync process", () => {
    const result = spawnSync(
        process.execPath,
        [
            resolve(__dirname, "../node_modules/tsx/dist/cli.mjs"),
            resolve(__dirname, "listener-crash-child.ts")
        ],
        { encoding: "utf8", timeout: 10000 }
    );
    assert.equal(result.status, 0, result.stderr);
});
