import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
    colorize,
    styleText,
    formatLogLine,
    colors
} from "./logger-formatter";
import { LogLevel } from "sync-client";

test("colorize - wraps text with ANSI color codes", () => {
    const result = colorize("hello", "red");
    assert.equal(result, `${colors.red}hello${colors.reset}`);
});

test("styleText - applies multiple modifiers", () => {
    const result = styleText("hello", "bold", "cyan");
    assert.equal(
        result,
        `${colors.bold}${colors.cyan}hello${colors.reset}`
    );
});

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
    assert.ok(result.includes(colors.bold));
});

test("formatLogLine - highlights file paths in quotes", () => {
    const logLine = {
        timestamp: new Date("2024-01-15T10:30:45.123Z"),
        level: LogLevel.INFO,
        message: 'Syncing "notes/test.md"'
    };

    const result = formatLogLine(logLine);
    assert.ok(result.includes(colors.magenta));
});

test("formatLogLine - highlights standalone numbers but not numbers in versions", () => {
    const logLine = {
        timestamp: new Date("2024-01-15T10:30:45.123Z"),
        level: LogLevel.INFO,
        message: "Listed 42 files from v1.2.3"
    };

    const result = formatLogLine(logLine);
    // "42" should be colorized (standalone number)
    assert.ok(result.includes(`${colors.cyan}42${colors.reset}`));
    // "1", "2", "3" in "v1.2.3" should NOT be colorized individually
    assert.ok(!result.includes(`${colors.cyan}1${colors.reset}.`));
});
