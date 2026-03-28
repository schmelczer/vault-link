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
        "--max-file-size-mb",
        "20"
    ]);

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

test("parseArgs - reads required options from environment variables", () => {
    process.env.VAULTLINK_LOCAL_PATH = "/env/path";
    process.env.VAULTLINK_REMOTE_URI = "https://env.example.com";
    process.env.VAULTLINK_TOKEN = "env-token";
    process.env.VAULTLINK_VAULT_NAME = "env-vault";

    try {
        const args = parseArgs(["node", "cli.js"]);
        assert.equal(args.localPath, "/env/path");
        assert.equal(args.remoteUri, "https://env.example.com");
        assert.equal(args.token, "env-token");
        assert.equal(args.vaultName, "env-vault");
    } finally {
        delete process.env.VAULTLINK_LOCAL_PATH;
        delete process.env.VAULTLINK_REMOTE_URI;
        delete process.env.VAULTLINK_TOKEN;
        delete process.env.VAULTLINK_VAULT_NAME;
    }
});

test("parseArgs - CLI arguments take precedence over environment variables", () => {
    process.env.VAULTLINK_TOKEN = "env-token";

    try {
        const args = parseArgs([
            "node",
            "cli.js",
            "-l",
            "/path/to/vault",
            "-r",
            "https://sync.example.com",
            "-t",
            "cli-token",
            "-v",
            "default"
        ]);
        assert.equal(args.token, "cli-token");
    } finally {
        delete process.env.VAULTLINK_TOKEN;
    }
});

test("parseArgs - reads log level from environment variable", () => {
    process.env.VAULTLINK_LOG_LEVEL = "DEBUG";

    try {
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
        assert.equal(args.logLevel, LogLevel.DEBUG);
    } finally {
        delete process.env.VAULTLINK_LOG_LEVEL;
    }
});

test("parseArgs - quiet defaults to false", () => {
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

    assert.equal(args.quiet, false);
});

test("parseArgs - parse --quiet flag", () => {
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
        "--quiet"
    ]);

    assert.equal(args.quiet, true);
});

test("parseArgs - parse -q short flag", () => {
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
        "-q"
    ]);

    assert.equal(args.quiet, true);
});

test("parseArgs - line-endings defaults to auto", () => {
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

    assert.equal(args.lineEndings, "auto");
});

test("parseArgs - parse --line-endings lf", () => {
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
        "--line-endings",
        "lf"
    ]);

    assert.equal(args.lineEndings, "lf");
});

test("parseArgs - parse --line-endings crlf", () => {
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
        "--line-endings",
        "crlf"
    ]);

    assert.equal(args.lineEndings, "crlf");
});

test("parseArgs - throws on invalid remote URI protocol", () => {
    assert.throws(() => {
        parseArgs([
            "node",
            "cli.js",
            "-l",
            "/path/to/vault",
            "-r",
            "ftp://sync.example.com",
            "-t",
            "mytoken",
            "-v",
            "default"
        ]);
    }, /Invalid remote URI/);
});

test("parseArgs - accepts http:// remote URI", () => {
    const args = parseArgs([
        "node",
        "cli.js",
        "-l",
        "/path/to/vault",
        "-r",
        "http://localhost:3000",
        "-t",
        "mytoken",
        "-v",
        "default"
    ]);

    assert.equal(args.remoteUri, "http://localhost:3000");
});

test("parseArgs - accepts wss:// remote URI", () => {
    const args = parseArgs([
        "node",
        "cli.js",
        "-l",
        "/path/to/vault",
        "-r",
        "wss://sync.example.com",
        "-t",
        "mytoken",
        "-v",
        "default"
    ]);

    assert.equal(args.remoteUri, "wss://sync.example.com");
});
