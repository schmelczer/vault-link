import { describe, it } from "node:test";
import assert from "node:assert";
import { Logger } from "../tracing/logger";
import { globsToRegexes } from "./globs-to-regexes";

describe("globsToRegexes", () => {
    it("basicExample", async () => {
        const [regex] = globsToRegexes([".git/**"], new Logger());

        assert.ok(regex.test(".git/objects/object"));
        assert.ok(regex.test(".git/objects/.object"));
    });
});
