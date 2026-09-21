import { TestRunner } from "./test-runner";
import { ServerControl } from "./server-control";
import { ServerManager } from "./server-manager";
import { PrefixedLogger } from "./prefixed-logger";
import { TESTS } from "./test-registry";
import type { TestDefinition, TestResult } from "./test-definition";
import { parseArgs } from "./parse-args";
import { runWithConcurrency } from "./run-with-concurrency";
import { TOKEN, SERVER_BINARY_PATH, CONFIG_PATH } from "./consts";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { Logger } from "sync-client";

const logger = new Logger();
logger.onLogEmitted.add((line) => console.log(line.message));

process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled Rejection: ${reason}`);
    process.exit(1);
});

process.on("uncaughtException", (error) => {
    logger.error(`Uncaught Exception: ${error}`);
    process.exit(1);
});

const serverManager = new ServerManager(logger);
serverManager.installSignalHandlers();

function testUsesPauseServer(test: TestDefinition): boolean {
    return test.steps.some(
        (step) =>
            step.type === "pause-server" ||
            step.type === "resume-server" ||
            step.type === "crash-server" ||
            step.type === "restart-server" ||
            step.type === "resume-server-until-history-then-pause"
    );
}

/**
 * Walk up from the CLI binary's location until we find a directory
 * containing `sync-server/` and `frontend/`.
 */
function findProjectRoot(): string {
    let dir = path.dirname(__filename);
    const { root } = path.parse(dir);
    while (dir !== root) {
        if (
            fs.existsSync(path.join(dir, "sync-server")) &&
            fs.existsSync(path.join(dir, "frontend"))
        ) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error(
        `Could not locate project root (no ancestor of ${__filename} contains both 'sync-server' and 'frontend')`
    );
}

interface NamedTestResult {
    name: string;
    result: TestResult;
}

async function runSharedServerTest(
    name: string,
    test: TestDefinition,
    sharedServer: ServerControl
): Promise<NamedTestResult> {
    const testLogger = new PrefixedLogger(logger, name);
    const runner = new TestRunner(
        sharedServer,
        testLogger,
        TOKEN,
        sharedServer.remoteUri
    );
    const result = await runner.runTest(name, test);
    if (result.success) {
        logger.info(`PASSED: ${name} (${result.duration}ms)`);
    } else {
        logger.error(`FAILED: ${name} - ${result.error}`);
    }
    return { name, result };
}

/**
 * Run a test with its own dedicated server (for tests that use pause-server).
 * SIGSTOP/SIGCONT affects the entire server process, so these tests need
 * isolated servers to avoid interfering with other tests.
 */
async function runDedicatedServerTest(
    name: string,
    test: TestDefinition,
    serverPath: string,
    configPath: string
): Promise<NamedTestResult> {
    const testLogger = new PrefixedLogger(logger, name);
    const server = new ServerControl(serverPath, configPath, testLogger);
    serverManager.track(server);

    try {
        await server.start();
        const runner = new TestRunner(
            server,
            testLogger,
            TOKEN,
            server.remoteUri
        );
        const result = await runner.runTest(name, test);
        if (result.success) {
            logger.info(`PASSED: ${name} (${result.duration}ms)`);
        } else {
            logger.error(`FAILED: ${name} - ${result.error}`);
        }
        return { name, result };
    } finally {
        await server.stop();
        serverManager.untrack(server);
    }
}

async function main(): Promise<void> {
    const projectRoot = findProjectRoot();
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

    const { filter, concurrency } = parseArgs(process.argv);
    const artifacts =
        process.env.E2E_ARTIFACTS ??
        fs.mkdtempSync(path.join(os.tmpdir(), "vault-link-deterministic-"));
    fs.mkdirSync(artifacts, { recursive: true });
    logger.info(`Artifacts: ${artifacts}`);

    const testsToRun: [string, TestDefinition][] = [];
    for (const [key, test] of Object.entries(TESTS)) {
        if (test) {
            if (
                filter !== undefined &&
                filter.length > 0 &&
                !key.includes(filter)
            ) {
                continue;
            }
            testsToRun.push([key, test]);
        }
    }

    if (testsToRun.length === 0) {
        logger.error(
            filter !== undefined && filter.length > 0
                ? `No tests matched filter "${filter}"`
                : "No tests found"
        );
        process.exit(1);
    }

    const regularTests = testsToRun.filter(([, t]) => !testUsesPauseServer(t));
    const pauseTests = testsToRun.filter(([, t]) => testUsesPauseServer(t));

    logger.info(`Server: ${serverPath}`);
    logger.info(`Config: ${configPath}`);
    logger.info(
        `Tests: ${testsToRun.length} total (${regularTests.length} regular, ${pauseTests.length} server-pause)`
    );
    logger.info(`Concurrency: ${concurrency}`);

    const allResults: NamedTestResult[] = [];

    if (regularTests.length > 0) {
        logger.info(
            `\n--- Running ${regularTests.length} regular tests (shared server, concurrency ${concurrency}) ---`
        );
        const sharedServer = new ServerControl(serverPath, configPath, logger);
        serverManager.track(sharedServer);

        try {
            await sharedServer.start();

            const results = await runWithConcurrency(
                regularTests,
                concurrency,
                async ([name, test]) =>
                    runSharedServerTest(name, test, sharedServer)
            );

            allResults.push(...results);
        } finally {
            await sharedServer.stop();
            serverManager.untrack(sharedServer);
        }
    }

    if (pauseTests.length > 0) {
        logger.info(
            `\n--- Running ${pauseTests.length} server-pause tests (dedicated servers, concurrency ${concurrency}) ---`
        );

        const results = await runWithConcurrency(
            pauseTests,
            concurrency,
            async ([name, test]) =>
                runDedicatedServerTest(name, test, serverPath, configPath)
        );

        allResults.push(...results);
    }

    const passed = allResults.filter((r) => r.result.success);
    const failed = allResults.filter((r) => !r.result.success);
    fs.writeFileSync(
        path.join(artifacts, "deterministic-results.json"),
        JSON.stringify(allResults, null, 2)
    );

    logger.info(
        `\n--- Results: ${passed.length}/${allResults.length} passed ---`
    );

    if (failed.length > 0) {
        for (const { name, result } of failed) {
            logger.error(`  FAILED: ${name}: ${result.error}`);
        }
        process.exit(1);
    } else {
        logger.info("All tests passed!");
        process.exit(0);
    }
}

main().catch((err: unknown) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
