import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Logger, LogLevel } from "../tracing/logger";
import { Settings } from "./settings";

describe("Settings logging", () => {
    it("redacts tokens while loading and updating settings", async () => {
        const logger = new Logger();
        const settings = new Settings(
            logger,
            { token: "loaded-secret" },
            async () => {}
        );
        await settings.setSettings({ token: "updated-secret" });

        const messages = logger
            .getMessages(LogLevel.DEBUG)
            .map((entry) => entry.message)
            .join("\n");
        assert.doesNotMatch(messages, /loaded-secret|updated-secret/u);
        assert.match(messages, /\[REDACTED\]/u);
    });
});
