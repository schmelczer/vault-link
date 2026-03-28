import { test } from "node:test";
import * as assert from "node:assert/strict";
import { formatLogLine } from "./logger-formatter";
import { LogLevel } from "sync-client";

test("formatLogLine - includes level and message", () => {
    const logLine = {
        timestamp: new Date("2024-01-15T10:30:45.123Z"),
        level: LogLevel.INFO,
        message: "Test message"
    };

    const result = formatLogLine(logLine);
    assert.ok(result.includes("INFO"));
    assert.ok(result.includes("Test message"));
});

test("formatLogLine - ERROR level messages contain bold escape", () => {
    const logLine = {
        timestamp: new Date("2024-01-15T10:30:45.123Z"),
        level: LogLevel.ERROR,
        message: "Error occurred"
    };

    const result = formatLogLine(logLine);
    assert.ok(result.includes("\x1b[1m"));
});

test("formatLogLine - highlights file paths in quotes", () => {
    const logLine = {
        timestamp: new Date("2024-01-15T10:30:45.123Z"),
        level: LogLevel.INFO,
        message: 'Syncing "notes/test.md"'
    };

    const result = formatLogLine(logLine);
    assert.ok(result.includes("\x1b[35m"));
});

test("formatLogLine - highlights standalone numbers but not numbers in versions", () => {
    const logLine = {
        timestamp: new Date("2024-01-15T10:30:45.123Z"),
        level: LogLevel.INFO,
        message: "Listed 42 files from v1.2.3"
    };

    const result = formatLogLine(logLine);
    assert.ok(result.includes("\x1b[36m42\x1b[0m"));
    assert.ok(!result.includes("\x1b[36m1\x1b[0m."));
});
