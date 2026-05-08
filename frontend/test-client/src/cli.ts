import type { SyncSettings } from "sync-client";
import { utils, debugging, Logger } from "sync-client";
import { MockAgent } from "./agent/mock-agent";
import { sleep } from "./utils/sleep";
import { v4 as uuidv4 } from "uuid";
import { randomCasing } from "./utils/random-casing";
import { TimeoutError } from "./utils/with-timeout";
import { TestErrorTracker } from "./utils/test-error-tracker";

const TEST_ITERATIONS = 5;
const MAX_INITIAL_DOCS = 10;

// Simulate async file access by injecting waiting time before returning from file operations.
let slowFileEvents = false;

// Whether to do resets in the test runs
let doResets = false;

const logger = new Logger();
debugging.logToConsole(logger);

const errorTracker = new TestErrorTracker();

async function runTest({
    agentCount,
    iterations,
    doDeletes,
    useResets,
    useSlowFileEvents,
    jitterScaleInSeconds
}: {
    agentCount: number;
    iterations: number;
    doDeletes: boolean;
    useResets: boolean;
    useSlowFileEvents: boolean;
    jitterScaleInSeconds: number;
}): Promise<void> {
    slowFileEvents = useSlowFileEvents;
    doResets = useResets;
    errorTracker.reset();

    const settings = `with ${agentCount} agents, iterations ${iterations}, doDeletes ${doDeletes}, doResets ${useResets}, jitterScaleInSeconds ${jitterScaleInSeconds}, useSlowFileEvents ${useSlowFileEvents}`;
    logger.info(`Running test ${settings}`);

    const vaultName = uuidv4();
    logger.info(`Using vault name: ${vaultName}`);
    const initialSettings: Partial<SyncSettings> = {
        isSyncEnabled: true,
        token: "   test-token-change-me     ", // same as in sync-server/config-e2e.yml with spaces
        vaultName: randomCasing(vaultName) + (Math.random() > 0.5 ? "  " : ""), // extra spaces shouldn't matter
        remoteUri: "http://localhost:3010"
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
                jitterScaleInSeconds,
                errorTracker
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

        errorTracker.checkAndThrow();

        logger.info("Stopping agents");

        // Drain pending actions and enable sync for each client
        for (const client of clients) {
            try {
                logger.info(`Finishing up ${client.name}`);
                await client.finish();
            } catch (err) {
                if (err instanceof TimeoutError || !slowFileEvents) {
                    throw err;
                }
            }
        }

        // Settling rounds: drain cascading broadcasts between agents
        for (let round = 0; round < 10; round++) {
            for (const client of clients) {
                try {
                    await client.waitUntilSynced();
                } catch (err) {
                    if (err instanceof TimeoutError || !slowFileEvents) {
                        throw err;
                    }
                }
            }
            // TODO: it's very ugly, let's remove this
            await sleep(2000);
        }

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
        errorTracker.checkAndThrow();

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

        clients.forEach((client) => {
            logger.info(
                `Checking binary content duplication for ${client.name}`
            );
            client.assertBinaryContentNotDuplicated();
            logger.info(
                `Binary content duplication check for ${client.name} passed`
            );
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
            iterations: 100,
            doDeletes: true,
            useResets: true,
            useSlowFileEvents: true,
            jitterScaleInSeconds: 0.75
        });

        for (const useSlowFileEvents of [true, false]) {
            for (const doDeletes of [false, true]) {
                await runTest({
                    agentCount: 2,
                    iterations: 100,
                    doDeletes,
                    useResets: false,
                    useSlowFileEvents,
                    jitterScaleInSeconds: 0.75
                });
            }
        }
    }

    await runTest({
        agentCount: 3,
        iterations: 75,
        doDeletes: true,
        useResets: false,
        useSlowFileEvents: false,
        jitterScaleInSeconds: 0.75
    });
    await runTest({
        agentCount: 3,
        iterations: 75,
        doDeletes: false,
        useResets: true,
        useSlowFileEvents: false,
        jitterScaleInSeconds: 0.75
    });
    await runTest({
        agentCount: 4,
        iterations: 50,
        doDeletes: true,
        useResets: false,
        useSlowFileEvents: false,
        jitterScaleInSeconds: 0.75
    });
    await runTest({
        agentCount: 2,
        iterations: 100,
        doDeletes: true,
        useResets: false,
        useSlowFileEvents: false,
        jitterScaleInSeconds: 0.1
    });
    await runTest({
        agentCount: 2,
        iterations: 100,
        doDeletes: true,
        useResets: true,
        useSlowFileEvents: false,
        jitterScaleInSeconds: 1.5
    });
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

    logger.error(`Error: uncaught exception: ${error}`);
    if (error instanceof Error && error.stack != null) {
        logger.error(error.stack);
    }
    process.exit(1);
});

process.on("unhandledRejection", (error, _promise) => {
    if (error instanceof Error && error.name === "SyncResetError") {
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
