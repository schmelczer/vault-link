#!/usr/bin/env node

import { TestRunner } from "./test-runner";
import { ServerControl } from "./server-control";
import type { TestDefinition } from "./test-definition";
import { writeWriteConflictTest } from "./tests/write-write-conflict.test";
import { renameCreateConflictTest } from "./tests/rename-create-conflict.test";
import * as path from "node:path";
import * as fs from "node:fs";

// Global error handlers to catch unhandled errors
process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise);
    console.error("Reason:", reason);
    process.exit(1);
});

process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    process.exit(1);
});

// Available tests - using Partial to allow undefined lookup
const TESTS: Partial<Record<string, TestDefinition>> = {
    "write-write-conflict": writeWriteConflictTest,
    "rename-create-conflict": renameCreateConflictTest
};

function printHelp(): void {
    console.log(`
Deterministic Test Runner for VaultLink

Usage:
  npm run test [options]

Options:
  --test <name>          Run specific test (or "all")
  --list                 List available tests
  --server <path>        Path to sync_server binary (default: auto-detect)
  --config <path>        Path to config file (default: config-e2e.yml)
  --no-manage-server     Don't start/stop server (assume it's running)
  --help, -h             Show this help

Examples:
  npm run test
  npm run test -- --test write-write-conflict
  npm run test -- --test all
  npm run test -- --list
  npm run test -- --no-manage-server --test rename-create-conflict
`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Parse arguments
    let testName: string | undefined = undefined;
    let serverPath: string | undefined = undefined;
    let configPath: string | undefined = undefined;
    let manageServer = true;

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--test" && i + 1 < args.length) {
            testName = args[++i];
        } else if (arg === "--server" && i + 1 < args.length) {
            serverPath = args[++i];
        } else if (arg === "--config" && i + 1 < args.length) {
            configPath = args[++i];
        } else if (arg === "--no-manage-server") {
            manageServer = false;
        } else if (arg === "--list") {
            console.log("\nAvailable tests:");
            for (const [name, test] of Object.entries(TESTS)) {
                if (test !== undefined) {
                    console.log(`  ${name}: ${test.description ?? test.name}`);
                }
            }
            process.exit(0);
        } else if (arg === "--help" || arg === "-h") {
            printHelp();
            process.exit(0);
        }
    }

    // Default values
    if (serverPath === undefined) {
        // Try to find project root from current working directory
        const cwd = process.cwd();
        let projectRoot = cwd;

        // If we're in frontend/deterministic-tests, go up two levels
        if (
            cwd.endsWith("frontend/deterministic-tests") ||
            cwd.endsWith("frontend\\deterministic-tests")
        ) {
            projectRoot = path.resolve(cwd, "../..");
        }
        // If we're in frontend, go up one level
        else if (cwd.endsWith("frontend") || cwd.endsWith("frontend\\")) {
            projectRoot = path.resolve(cwd, "..");
        }

        serverPath = path.join(
            projectRoot,
            "sync-server/target/debug/sync_server"
        );

        // Check if server binary exists
        if (!fs.existsSync(serverPath)) {
            console.error(`Server binary not found at: ${serverPath}`);
            console.error(
                "Please build the server first: cd sync-server && cargo build"
            );
            console.error(`Current working directory: ${cwd}`);
            console.error(`Project root detected as: ${projectRoot}`);
            process.exit(1);
        }
    }

    if (configPath === undefined) {
        const cwd = process.cwd();
        let projectRoot = cwd;

        if (
            cwd.endsWith("frontend/deterministic-tests") ||
            cwd.endsWith("frontend\\deterministic-tests")
        ) {
            projectRoot = path.resolve(cwd, "../..");
        } else if (cwd.endsWith("frontend") || cwd.endsWith("frontend\\")) {
            projectRoot = path.resolve(cwd, "..");
        }

        configPath = path.join(projectRoot, "sync-server/config-e2e.yml");

        if (!fs.existsSync(configPath)) {
            console.error(`Config file not found at: ${configPath}`);
            process.exit(1);
        }
    }

    // Determine which tests to run
    const testsToRun: TestDefinition[] = [];

    // Collect all defined tests
    const allTests: TestDefinition[] = [];
    for (const test of Object.values(TESTS)) {
        if (test !== undefined) {
            allTests.push(test);
        }
    }

    if (testName !== undefined) {
        if (testName === "all") {
            testsToRun.push(...allTests);
        } else {
            const test = TESTS[testName];
            if (test === undefined) {
                console.error(`Unknown test: ${testName}`);
                console.error(
                    `Available tests: ${Object.keys(TESTS).join(", ")}, all`
                );
                process.exit(1);
            }
            testsToRun.push(test);
        }
    } else {
        // Default: run all tests
        testsToRun.push(...allTests);
    }

    console.log(`\nDeterministic Test Suite`);
    console.log("=".repeat(80));
    console.log(`Server: ${serverPath}`);
    console.log(`Config: ${configPath}`);
    console.log(`Manage server: ${manageServer}`);
    console.log(`Tests to run: ${testsToRun.length}`);
    console.log(`${"=".repeat(80)}\n`);

    // Initialize server control
    const serverControl = new ServerControl(serverPath, configPath);

    let allPassed = true;

    try {
        // Start server if we're managing it
        if (manageServer) {
            await serverControl.start();
        } else {
            console.log("Assuming server is already running...");
            await serverControl.waitForReady();
        }

        // Run tests
        for (const test of testsToRun) {
            const runner = new TestRunner(serverControl);
            const result = await runner.runTest(test);

            if (!result.success) {
                allPassed = false;
                console.error(`\n✗ FAILED: ${test.name}`);
                console.error(`Error: ${result.error}`);
            } else {
                console.log(`\n✓ PASSED: ${test.name} (${result.duration}ms)`);
            }

            // Add delay between tests
            if (testsToRun.indexOf(test) < testsToRun.length - 1) {
                console.log("\nWaiting 2s before next test...\n");
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        }
    } finally {
        // Stop server if we're managing it
        if (manageServer) {
            await serverControl.stop();
        }
    }

    console.log(`\n${"=".repeat(80)}`);
    if (allPassed) {
        console.log("✓ All tests passed!");
        process.exit(0);
    } else {
        console.log("✗ Some tests failed");
        process.exit(1);
    }
}

main().catch((err: unknown) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
