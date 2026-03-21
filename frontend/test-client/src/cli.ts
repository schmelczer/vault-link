import type { SyncSettings } from "sync-client";
import { utils, debugging, Logger } from "sync-client";
import { MockAgent } from "./agent/mock-agent";
import { assert } from "./utils/assert";
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

function countFileMismatches(clients: MockAgent[]): number {
    let mismatches = 0;
    for (let i = 0; i < clients.length - 1; i++) {
        const aFiles = new Set(clients[i].getFileList());
        const bFiles = new Set(clients[i + 1].getFileList());
        for (const f of aFiles) {
            if (!bFiles.has(f)) mismatches++;
        }
        for (const f of bFiles) {
            if (!aFiles.has(f)) mismatches++;
        }
    }
    return mismatches;
}

interface ServerDocument {
    documentId: string;
    relativePath: string;
    isDeleted: boolean;
    vaultUpdateId: number;
}

// Server-side invariants that hold regardless of client file-event
// timing. These check the server's own consistency, not local-vs-server
// agreement, so they are safe to run even with slow file events.
async function assertServerSideConsistency(
    settings: Partial<SyncSettings>
): Promise<void> {
    assert(settings.vaultName !== undefined, "vaultName is required");
    assert(settings.token !== undefined, "token is required");

    const vaultName = encodeURIComponent(settings.vaultName.trim());
    const baseUrl = `${settings.remoteUri}/vaults/${vaultName}`;
    const headers = {
        authorization: `Bearer ${settings.token.trim()}`
    };

    const response = await fetch(`${baseUrl}/documents`, { headers });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const result = (await response.json()) as {
        latestDocuments: ServerDocument[];
    };

    const serverDocs = result.latestDocuments.filter((d) => !d.isDeleted);

    // No two non-deleted documents should share the same path
    const pathCounts = new Map<string, number>();
    for (const doc of serverDocs) {
        const count = pathCounts.get(doc.relativePath) ?? 0;
        pathCounts.set(doc.relativePath, count + 1);
    }
    for (const [path, count] of pathCounts) {
        assert(
            count === 1,
            `[server-consistency] Duplicate non-deleted documents at path '${path}' (count: ${count})`
        );
    }

    // Every document's content should be retrievable
    for (const doc of serverDocs) {
        const contentResponse = await fetch(
            `${baseUrl}/documents/${doc.documentId}/versions/${doc.vaultUpdateId}/content`,
            { headers }
        );
        assert(
            contentResponse.ok,
            `[server-consistency] Failed to fetch content for '${doc.relativePath}' (id: ${doc.documentId}): ${contentResponse.status}`
        );
    }
}

async function assertServerStateConsistency(
    agent: MockAgent,
    settings: Partial<SyncSettings>
): Promise<void> {
    assert(settings.vaultName !== undefined, "vaultName is required");
    assert(settings.token !== undefined, "token is required");

    const vaultName = encodeURIComponent(settings.vaultName.trim());
    const baseUrl = `${settings.remoteUri}/vaults/${vaultName}`;
    const headers = {
        authorization: `Bearer ${settings.token.trim()}`
    };

    const response = await fetch(`${baseUrl}/documents`, { headers });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const result = (await response.json()) as {
        latestDocuments: ServerDocument[];
    };

    const serverDocs = result.latestDocuments.filter((d) => !d.isDeleted);
    const localFiles = agent.getFileList();

    // Every local file should have a corresponding server document
    for (const localFile of localFiles) {
        const serverDoc = serverDocs.find(
            (d) => d.relativePath === localFile
        );
        assert(
            serverDoc !== undefined,
            `[server-consistency] Local file '${localFile}' not found on server`
        );
    }

    // Every non-deleted server document should have a local file
    for (const serverDoc of serverDocs) {
        assert(
            localFiles.includes(serverDoc.relativePath),
            `[server-consistency] Server document '${serverDoc.relativePath}' (id: ${serverDoc.documentId}) not found locally`
        );
    }

    // Verify content matches for each document
    for (const serverDoc of serverDocs) {
        const contentResponse = await fetch(
            `${baseUrl}/documents/${serverDoc.documentId}/versions/${serverDoc.vaultUpdateId}/content`,
            { headers }
        );
        const serverBytes = new Uint8Array(
            await contentResponse.arrayBuffer()
        );
        const localBytes = agent.getFileContent(serverDoc.relativePath);

        assert(
            localBytes !== undefined,
            `[server-consistency] Local file '${serverDoc.relativePath}' content is undefined`
        );

        const serverText = new TextDecoder().decode(serverBytes);
        const localText = new TextDecoder().decode(localBytes);
        assert(
            serverText === localText,
            `[server-consistency] Content mismatch for '${serverDoc.relativePath}':\n  server: '${serverText}'\n  local:  '${localText}'`
        );
    }
}

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

        // Wait for in-flight broadcasts to propagate and be processed
        await sleep(5000);
        for (const client of clients) {
            try {
                await client.waitUntilSynced();
            } catch (err) {
                if (err instanceof TimeoutError || !slowFileEvents) {
                    throw err;
                }
            }
        }

        // Stuck detection: if agents haven't converged yet, retry
        // to distinguish "still propagating" from "permanently stuck".
        if (!slowFileEvents) {
            const MAX_CONVERGENCE_RETRIES = 3;
            for (let retry = 0; retry < MAX_CONVERGENCE_RETRIES; retry++) {
                const mismatches = countFileMismatches(clients);
                if (mismatches === 0) break;

                logger.info(
                    `Convergence retry ${retry + 1}/${MAX_CONVERGENCE_RETRIES}: ${mismatches} file mismatches, waiting 5s...`
                );
                await sleep(5000);
                for (const client of clients) {
                    await client.waitUntilSynced();
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

        // Server-side invariants (no duplicate paths, content retrievable)
        // hold regardless of file-event timing — always check them.
        logger.info("Checking server-side consistency");
        await assertServerSideConsistency(initialSettings);
        logger.info("Server-side consistency check passed");

        // Local-vs-server comparison can only be checked when file events
        // are immediate. With slow events, operations can timeout before
        // the local state fully converges with the server, leaving
        // local-only files (from deconfliction) that were never uploaded.
        if (!slowFileEvents) {
            logger.info("Checking local-server state consistency");
            await assertServerStateConsistency(clients[0], initialSettings);
            logger.info("Local-server state consistency check passed");
        }

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

    // Multi-agent tests (once per process, not repeated TEST_ITERATIONS times)
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

    // Jitter scale variation (once per process)
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

    logger.error(`Error - uncaught exception: ${error}`);
    if (error instanceof Error && error.stack != null) {
        logger.error(error.stack);
    }
    process.exit(1);
});

process.on("unhandledRejection", (error, _promise) => {
    if (
        error instanceof Error &&
        (error.message === "Sync was reset" ||
            error.name === "SyncResetError")
    ) {
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
