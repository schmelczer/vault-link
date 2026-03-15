import type { SyncSettings } from "sync-client";
import { utils, debugging, Logger } from "sync-client";
import { MockAgent } from "./agent/mock-agent";
import { sleep } from "./utils/sleep";
import { v4 as uuidv4 } from "uuid";
import { randomCasing } from "./utils/random-casing";
import { TimeoutError } from "./utils/with-timeout";

const TEST_ITERATIONS = 5;
const MAX_INITIAL_DOCS = 10;

// Simulate async file access by injecting waiting time before returning from file operations.
let slowFileEvents = false;

// Whether to do resets in the test runs
let doResets = false;

const logger = new Logger();
debugging.logToConsole(logger);

async function runTest({
    agentCount,
    concurrency,
    iterations,
    doDeletes,
    useResets,
    useSlowFileEvents,
    jitterScaleInSeconds
}: {
    agentCount: number;
    concurrency: number;
    iterations: number;
    doDeletes: boolean;
    useResets: boolean;
    useSlowFileEvents: boolean;
    jitterScaleInSeconds: number;
}): Promise<void> {
    slowFileEvents = useSlowFileEvents;
    doResets = useResets;

    const settings = `with ${agentCount} agents, concurrency ${concurrency}, iterations ${iterations}, doDeletes ${doDeletes}, doResets ${useResets}, jitterScaleInSeconds ${jitterScaleInSeconds}, useSlowFileEvents ${useSlowFileEvents}`;
    logger.info(`Running test ${settings}`);

    const vaultName = uuidv4();
    logger.info(`Using vault name: ${vaultName}`);
    const initialSettings: Partial<SyncSettings> = {
        isSyncEnabled: true,
        token: "   test-token-change-me     ", // same as in sync-server/config-e2e.yml with spaces
        vaultName: randomCasing(vaultName) + (Math.random() > 0.5 ? "  " : ""), // extra spaces shouldn't matter
        syncConcurrency: concurrency,
        remoteUri: "http://localhost:3000"
    };

    const clients: MockAgent[] = [];
    for (let i = 0; i < agentCount; i++) {
        clients.push(
            new MockAgent(
                initialSettings,
                `agent-${i}`,
                doDeletes,
                useResets,
                useSlowFileEvents,
                jitterScaleInSeconds
            )
        );
    }

    try {
        for (const client of clients) {
            const initialDocCount = Math.floor(
                Math.random() * MAX_INITIAL_DOCS
            );
            if (initialDocCount > 0) {
                logger.info(
                    `Creating ${initialDocCount} initial documents for ${client.name}`
                );
                await client.createInitialDocuments(initialDocCount);
            }
        }

        await utils.awaitAll(clients.map(async (client) => client.init()));

        for (let i = 0; i < iterations; i++) {
            logger.info(`Iteration ${i + 1}/${iterations}`);
            await utils.awaitAll(clients.map(async (client) => client.act()));
            await sleep(Math.random() * 200);
        }

        logger.info("Stopping agents");

        // Each agent can have unpushed changes which might conflict with eachother so each has to resolve the conflicts & push, and pull
        for (const client of clients) {
            try {
                logger.info(`Finishing up ${client.name}`);
                await client.waitUntilSynced();
                await client.finish();
            } catch (err) {
                if (err instanceof TimeoutError || !slowFileEvents) {
                    throw err;
                }
            }
        }

        // then we need a second pass to ensure that all agents pull the same state
        for (const client of clients) {
            try {
                logger.info(`Destroying ${client.name}`);
                await client.destroy();
            } catch (err) {
                if (err instanceof TimeoutError || !slowFileEvents) {
                    throw err;
                }
            }
        }

        logger.info("Agents finished successfully");

        clients.slice(0, -1).forEach((client, i) => {
            logger.info(
                `Checking consistency between ${client.name} and ${clients[i + 1].name}`
            );
            client.assertFileSystemsAreConsistent(clients[i + 1]);
            logger.info(`Consistency check for ${client.name} passed`);
        });

        logger.info("File systems found to be consistent");

        clients.forEach((client) => {
            logger.info(`Checking content for ${client.name}`);
            client.assertAllContentIsPresentOnce();
            logger.info(`Content check for ${client.name} passed`);
        });

        logger.info(`Test passed ${settings}`);
    } catch (err) {
        logger.error(`Test failed ${settings}`);
        throw err;
    }
}

async function runTests(): Promise<void> {
    for (let i = 0; i < TEST_ITERATIONS; i++) {
        await runTest({
            agentCount: 2,
            concurrency: 16,
            iterations: 100,
            doDeletes: true,
            useResets: true,
            useSlowFileEvents: true,
            jitterScaleInSeconds: 0.75
        });

        for (const useSlowFileEvents of [true, false]) {
            for (const concurrency of [
                16,
                1 // test with concurrency 1 to check for deadlocks
            ]) {
                for (const doDeletes of [false, true]) {
                    await runTest({
                        agentCount: 2,
                        concurrency,
                        iterations: 100,
                        doDeletes,
                        useResets: false,
                        useSlowFileEvents,
                        jitterScaleInSeconds: 0.75
                    });
                }
            }
        }
    }
}

process.on("uncaughtException", (error) => {
    if (
        error instanceof Error &&
        error.message.includes(
            "WebSocket was closed before the connection was established"
        )
    ) {
        return;
    }

    logger.error(`Error - uncaught exception: ${error}`);
    if (error instanceof Error && error.stack != null) {
        logger.error(error.stack);
    }
    process.exit(1);
});

process.on("unhandledRejection", (error, _promise) => {
    if (error instanceof Error && error.message === "Sync was reset") {
        return;
    }

    if (
        slowFileEvents &&
        error instanceof Error &&
        (error.message.includes("Document not found") ||
            error.message.includes("Document already exists at new location"))
    ) {
        return;
    }

    if (
        doResets &&
        error instanceof Error &&
        error.message.includes(
            "SyncClient has been destroyed and can no longer be used"
        )
    ) {
        return;
    }

    logger.error(`Error - unhandled rejection: ${error}`);
    if (error instanceof Error && error.stack != null) {
        logger.error(error.stack);
    }
    process.exit(1);
});

runTests()
    .then(() => {
        process.exit(0);
    })
    .catch((error: unknown) => {
        logger.error(`Error - tests failed with ${error}`);
        if (error instanceof Error && error.stack != null) {
            logger.error(error.stack);
        }
        process.exit(1);
    });
