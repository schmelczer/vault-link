#!/usr/bin/env node

import { TestRunner } from "./test-runner";
import { ServerControl } from "./server-control";
import type { TestDefinition } from "./test-definition";
import { writeWriteConflictTest } from "./tests/write-write-conflict.test";
import { renameCreateConflictTest } from "./tests/rename-create-conflict.test";
import { TOKEN, REMOTE_URI, SERVER_BINARY_PATH, CONFIG_PATH } from "./consts";
import * as path from "node:path";
import * as fs from "node:fs";
import { debugging, Logger } from "sync-client";

const logger = new Logger();
debugging.logToConsole(logger, { useColors: true });

process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
    process.exit(1);
});

process.on("uncaughtException", (error) => {
    logger.error(`Uncaught Exception: ${error}`);
    process.exit(1);
});

const TESTS: Partial<Record<string, TestDefinition>> = {
    "write-write-conflict": writeWriteConflictTest,
    "rename-create-conflict": renameCreateConflictTest
};

async function main(): Promise<void> {
    const cwd = process.cwd();
    let projectRoot = cwd;

    if (cwd.endsWith("frontend/deterministic-tests")) {
        projectRoot = path.resolve(cwd, "../..");
    } else if (cwd.endsWith("frontend")) {
        projectRoot = path.resolve(cwd, "..");
    }

    const serverPath = path.join(projectRoot, SERVER_BINARY_PATH);
    if (!fs.existsSync(serverPath)) {
        logger.error(`Server binary not found at: ${serverPath}`);
        process.exit(1);
    }

    const configPath = path.join(projectRoot, CONFIG_PATH);
    if (!fs.existsSync(configPath)) {
        logger.error(`Config file not found at: ${configPath}`);
        process.exit(1);
    }

    const testsToRun: TestDefinition[] = [];
    for (const test of Object.values(TESTS)) {
        if (test) {
            testsToRun.push(test);
        }
    }

    logger.info(`Server: ${serverPath}`);
    logger.info(`Config: ${configPath}`);
    logger.info(`Tests to run: ${testsToRun.length}`);

    const serverControl = new ServerControl(serverPath, configPath, logger);

    let allPassed = true;

    try {
        await serverControl.start();
        await serverControl.waitForReady();

        for (const test of testsToRun) {
            const runner = new TestRunner(
                serverControl,
                logger,
                TOKEN,
                REMOTE_URI
            );
            const result = await runner.runTest(test);

            if (!result.success) {
                allPassed = false;
                logger.error(`✗ FAILED: ${test.name}`);
                logger.error(`Error: ${result.error}`);
            } else {
                logger.info(`✓ PASSED: ${test.name} (${result.duration}ms)`);
            }
        }
    } finally {
        await serverControl.stop();
    }

    if (allPassed) {
        logger.info("✓ All tests passed!");
        process.exit(0);
    } else {
        logger.info("✗ Some tests failed");
        process.exit(1);
    }
}

main().catch((err: unknown) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
