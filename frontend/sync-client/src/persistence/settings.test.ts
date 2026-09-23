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

    it("retains and persists the configured diff cache size", async () => {
        let saved = 0;
        const settings = new Settings(
            new Logger(),
            { diffCacheSizeMB: 7 },
            async (value) => {
                saved = value.diffCacheSizeMB;
            }
        );

        assert.equal(settings.getSettings().diffCacheSizeMB, 7);
        await settings.setSetting("diffCacheSizeMB", 9);
        assert.equal(settings.getSettings().diffCacheSizeMB, 9);
        assert.equal(saved, 9);
    });
});

it("owns settings arrays instead of sharing them with callers and listeners", async () => {
    const original = ["original"];
    const settings = new Settings(
        new Logger(),
        { ignorePatterns: original },
        async () => {}
    );
    original.push("external mutation");
    assert.deepEqual(settings.getSettings().ignorePatterns, ["original"]);
    const update = ["updated"];
    await settings.setSettings({ ignorePatterns: update });
    update.push("external mutation");
    assert.deepEqual(settings.getSettings().ignorePatterns, ["updated"]);
    settings.onSettingsChanged.add((_, old) => {
        old.ignorePatterns.push("listener mutation");
    });
    await settings.setSettings({ maxFileSizeMB: 12 });
    assert.deepEqual(settings.getSettings().ignorePatterns, ["updated"]);
});

it("file eligibility follows successfully saved settings", async () => {
    let fail = false;
    const settings = new Settings(
        new Logger(),
        {
            ignorePatterns: ["private/**"],
            maxFileSizeMB: 1
        },
        async () => {
            if (fail) throw new Error("save failed");
        }
    );
    assert(settings.isIgnored("private/note.md"));
    assert(settings.isIgnored(".vault-link-sync/state.json"));
    assert(!settings.isIgnored("public/note.md"));
    assert(!settings.isOversized(1024 * 1024));
    assert(settings.isOversized(1024 * 1024 + 1));
    fail = true;
    await assert.rejects(
        settings.setSettings({ ignorePatterns: [], maxFileSizeMB: 2 }),
        /save failed/
    );
    assert(settings.isIgnored("private/note.md"));
    assert(settings.isOversized(1024 * 1024 + 1));
    fail = false;
    await settings.setSettings({ ignorePatterns: [], maxFileSizeMB: 2 });
    assert(!settings.isIgnored("private/note.md"));
    assert(!settings.isOversized(1024 * 1024 + 1));
});
