import { test } from "node:test";
import * as assert from "node:assert/strict";
import { parseArgs } from "./args";
import { LogLevel } from "sync-client";

test("parseArgs - parse basic arguments", () => {
    const args = parseArgs([
        "node",
        "cli.js",
        "-l",
        "/path/to/vault",
        "-r",
        "https://sync.example.com",
        "-t",
        "mytoken",
        "-v",
        "default"
    ]);

    assert.equal(args.localPath, "/path/to/vault");
    assert.equal(args.remoteUri, "https://sync.example.com");
    assert.equal(args.token, "mytoken");
    assert.equal(args.vaultName, "default");
});

test("parseArgs - parse long form arguments", () => {
    const args = parseArgs([
        "node",
        "cli.js",
        "--local-path",
        "/path/to/vault",
        "--remote-uri",
        "https://sync.example.com",
        "--token",
        "mytoken",
        "--vault-name",
        "default"
    ]);

    assert.equal(args.localPath, "/path/to/vault");
    assert.equal(args.remoteUri, "https://sync.example.com");
    assert.equal(args.token, "mytoken");
    assert.equal(args.vaultName, "default");
});

test("parseArgs - parse with optional arguments", () => {
    const args = parseArgs([
        "node",
        "cli.js",
        "-l",
        "/path/to/vault",
        "-r",
        "https://sync.example.com",
        "-t",
        "mytoken",
        "-v",
        "default",
        "--sync-concurrency",
        "5",
        "--max-file-size-mb",
        "20"
    ]);

    assert.equal(args.syncConcurrency, 5);
    assert.equal(args.maxFileSizeMB, 20);
});

test("parseArgs - parse with multiple ignore patterns", () => {
    const args = parseArgs([
        "node",
        "cli.js",
        "-l",
        "/path/to/vault",
        "-r",
        "https://sync.example.com",
        "-t",
        "mytoken",
        "-v",
        "default",
        "--ignore-pattern",
        ".git/**",
        "*.tmp"
    ]);

    assert.deepEqual(args.ignorePatterns, [".git/**", "*.tmp"]);
});

test("parseArgs - throws on missing required arguments", () => {
    assert.throws(() => {
        parseArgs(["node", "cli.js", "-r", "https://sync.example.com"]);
    }, /required option/);
});

test("parseArgs - throws on missing remote uri", () => {
    assert.throws(() => {
        parseArgs([
            "node",
            "cli.js",
            "-l",
            "/path/to/vault",
            "-t",
            "mytoken",
            "-v",
            "default"
        ]);
    }, /--remote-uri/);
});

test("parseArgs - throws on missing token", () => {
    assert.throws(() => {
        parseArgs([
            "node",
            "cli.js",
            "-l",
            "/path/to/vault",
            "-r",
            "https://sync.example.com",
            "-v",
            "default"
        ]);
    }, /--token/);
});

test("parseArgs - throws on missing vault name", () => {
    assert.throws(() => {
        parseArgs([
            "node",
            "cli.js",
            "-l",
            "/path/to/vault",
            "-r",
            "https://sync.example.com",
            "-t",
            "mytoken"
        ]);
    }, /--vault-name/);
});

test("parseArgs - default log level is INFO", () => {
    const args = parseArgs([
        "node",
        "cli.js",
        "-l",
        "/path/to/vault",
        "-r",
        "https://sync.example.com",
        "-t",
        "mytoken",
        "-v",
        "default"
    ]);

    assert.equal(args.logLevel, LogLevel.INFO);
});

test("parseArgs - parse DEBUG log level", () => {
    const args = parseArgs([
        "node",
        "cli.js",
        "-l",
        "/path/to/vault",
        "-r",
        "https://sync.example.com",
        "-t",
        "mytoken",
        "-v",
        "default",
        "--log-level",
        "DEBUG"
    ]);

    assert.equal(args.logLevel, LogLevel.DEBUG);
});

test("parseArgs - parse ERROR log level", () => {
    const args = parseArgs([
        "node",
        "cli.js",
        "-l",
        "/path/to/vault",
        "-r",
        "https://sync.example.com",
        "-t",
        "mytoken",
        "-v",
        "default",
        "--log-level",
        "ERROR"
    ]);

    assert.equal(args.logLevel, LogLevel.ERROR);
});

test("parseArgs - log level is case insensitive", () => {
    const args = parseArgs([
        "node",
        "cli.js",
        "-l",
        "/path/to/vault",
        "-r",
        "https://sync.example.com",
        "-t",
        "mytoken",
        "-v",
        "default",
        "--log-level",
        "debug"
    ]);

    assert.equal(args.logLevel, LogLevel.DEBUG);
});

test("parseArgs - throws on invalid log level", () => {
    assert.throws(() => {
        parseArgs([
            "node",
            "cli.js",
            "-l",
            "/path/to/vault",
            "-r",
            "https://sync.example.com",
            "-t",
            "mytoken",
            "-v",
            "default",
            "--log-level",
            "INVALID"
        ]);
    }, /Invalid log level/);
});
