import type { TestDefinition, TestResult, TestStep } from "./test-definition";
import { DeterministicAgent } from "./deterministic-agent";
import type { ServerControl } from "./server-control";
import type { SyncSettings, Logger } from "sync-client";
import { assert } from "./utils/assert";
import { AssertableState } from "./utils/assertable-state";
import { sleep } from "./utils/sleep";
import { withTimeout } from "./utils/with-timeout";
import {
    CONVERGENCE_TIMEOUT_MS,
    CONVERGENCE_RETRY_DELAY_MS,
    AGENT_INIT_TIMEOUT_MS,
    IS_SYNC_ENABLED_BY_DEFAULT
} from "./consts";
import { randomUUID } from "node:crypto";

export class TestRunner {
    private agents: DeterministicAgent[] = [];
    private readonly serverControl: ServerControl;
    private readonly token: string;
    private readonly remoteUri: string;
    private readonly logger: Logger;

    public constructor(
        serverControl: ServerControl,
        logger: Logger,
        token: string,
        remoteUri: string
    ) {
        this.serverControl = serverControl;
        this.logger = logger;
        this.token = token;
        this.remoteUri = remoteUri;
    }

    public async runTest(
        name: string,
        test: TestDefinition
    ): Promise<TestResult> {
        const startTime = Date.now();
        this.logger.info(`Running test: ${name}`);
        if (test.description !== undefined && test.description !== "") {
            this.logger.info(`Description: ${test.description}`);
        }
        this.logger.info(`Clients: ${test.clients}`);
        this.logger.info(`Steps: ${test.steps.length}`);

        try {
            assert(
                this.serverControl.isRunning(),
                "Server is not running before test start"
            );

            await this.initializeAgents(test.clients);

            for (let i = 0; i < test.steps.length; i++) {
                const step = test.steps[i];
                this.logger.info(
                    `Step ${i + 1}/${test.steps.length}: ${JSON.stringify(step)}`
                );
                await this.executeStep(step);
            }

            await this.cleanup();

            const duration = Date.now() - startTime;
            this.logger.info(`\n✓ Test passed: ${name} (${duration}ms)`);

            return {
                success: true,
                duration
            };
        } catch (error) {
            const duration = Date.now() - startTime;
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.logger.info(`\n✗ Test failed: ${name}`);
            this.logger.info(`Error: ${errorMessage}`);

            await this.cleanup();

            return {
                success: false,
                error: errorMessage,
                duration
            };
        }
    }

    private async initializeAgents(count: number): Promise<void> {
        assert(count > 0, `Client count must be positive, got ${count}`);
        const vaultName = `test-${randomUUID()}`;
        this.logger.info(
            `Initializing ${count} agents with vault: ${vaultName}`
        );

        for (let i = 0; i < count; i++) {
            const settings: Partial<SyncSettings> = {
                isSyncEnabled: IS_SYNC_ENABLED_BY_DEFAULT,
                token: this.token,
                vaultName,
                remoteUri: this.remoteUri
            };

            const agent = new DeterministicAgent(i, settings, (msg) => {
                this.logger.info(msg);
            });

            // Push before init so cleanup() handles this agent if init fails
            this.agents.push(agent);
            await withTimeout(
                agent.init(fetch),
                AGENT_INIT_TIMEOUT_MS,
                `Client ${i} init timed out after ${AGENT_INIT_TIMEOUT_MS}ms`
            );
            this.logger.info(`Initialized client ${i}`);
        }

        this.logger.info("All agents initialized");
    }

    private getAgent(index: number): DeterministicAgent {
        assert(
            index >= 0 && index < this.agents.length,
            `Client index ${index} out of bounds (have ${this.agents.length} agents)`
        );
        return this.agents[index];
    }

    private async executeStep(step: TestStep): Promise<void> {
        switch (step.type) {
            case "create":
            case "update":
                await this.getAgent(step.client).write(
                    step.path,
                    new TextEncoder().encode(step.content)
                );
                break;

            case "rename":
                await this.getAgent(step.client).rename(
                    step.oldPath,
                    step.newPath
                );
                break;

            case "rename-next-write":
                this.getAgent(step.client).renameNextWrite(
                    step.oldPath,
                    step.newPath
                );
                break;

            case "delete":
                await this.getAgent(step.client).delete(step.path);
                break;

            case "sync":
                if (step.client !== undefined) {
                    await this.getAgent(step.client).waitForSync();
                } else {
                    for (const agent of this.agents) {
                        await agent.waitForSync();
                    }
                }
                break;

            case "disable-sync":
                await this.getAgent(step.client).disableSync();
                break;

            case "enable-sync":
                await this.getAgent(step.client).enableSync();
                break;

            case "pause-server":
                this.serverControl.pause();
                break;

            case "resume-server":
                this.serverControl.resume();
                // Verify the server is actually responsive before proceeding.
                // This replaces relying solely on hardcoded waits.
                await this.serverControl.waitForReady();
                break;

            case "resume-server-until-history-then-pause": {
                const agent = this.getAgent(step.client);
                const historySeen = agent.waitForHistoryEntry(
                    (entry) =>
                        entry.details.type === step.syncType &&
                        entry.details.relativePath === step.path,
                    () => this.serverControl.pause()
                );
                this.serverControl.resume();
                await historySeen;
                break;
            }

            case "barrier":
                await this.waitForConvergence();
                break;

            case "assert-consistent":
                await this.assertConsistent(step.verify);
                break;

            case "pause-websocket":
                this.getAgent(step.client).pauseWebSocket();
                break;

            case "resume-websocket":
                this.getAgent(step.client).resumeWebSocket();
                break;

            case "drop-next-create-response":
                this.getAgent(step.client).dropNextCreateResponse();
                break;

            case "wait-for-dropped-create-response":
                await this.getAgent(step.client).waitForDroppedCreateResponse();
                break;

            case "sleep":
                await sleep(step.ms);
                break;

            case "reset":
                await this.getAgent(step.client).reset();
                break;

            default: {
                const unknownStep = step as { type: string };
                throw new Error(`Unknown step type: ${unknownStep.type}`);
            }
        }
    }

    /**
     * Wait for all agents to reach a consistent state.
     *
     * Waiting for agents is done in two full rounds: the first round
     * drains in-flight operations, but completing those operations can
     * trigger new work on OTHER agents via server broadcasts. The second
     * round waits for that cascading work to settle. Deeper cascades
     * are handled by the outer retry loop.
     */
    private async waitForConvergence(): Promise<void> {
        this.logger.info("Barrier: waiting for convergence...");

        const deadline = Date.now() + CONVERGENCE_TIMEOUT_MS;
        let lastError: Error | undefined = undefined;

        while (Date.now() < deadline) {
            await this.waitAllAgentsSettled();

            try {
                await this.assertConsistent();
                this.logger.info("Barrier complete: all clients converged");
                return;
            } catch (error) {
                lastError =
                    error instanceof Error ? error : new Error(String(error));
                this.logger.info("Barrier: not yet converged, retrying...");
                await sleep(CONVERGENCE_RETRY_DELAY_MS);
            }
        }

        // Final attempt — let the error propagate
        await this.waitAllAgentsSettled();

        try {
            await this.assertConsistent();
            this.logger.info("Barrier complete: all clients converged");
        } catch (error) {
            throw new Error(
                `Convergence timed out after ${CONVERGENCE_TIMEOUT_MS}ms: ${error instanceof Error ? error.message : String(error)}`,
                { cause: lastError }
            );
        }
    }

    /**
     * Wait for all agents to be simultaneously idle.
     *
     * Completing work on agent A can trigger a server broadcast that
     * enqueues new work on agent B, which can cascade further. With N
     * agents the worst-case cascade depth is N (a chain A→B→C→…→A),
     * so we run N+1 sequential passes to drain it. Extra passes are
     * essentially free when there is no outstanding work.
     *
     * The outer {@link waitForConvergence} loop with consistency checks
     * remains the ultimate guarantee — this method just minimizes how
     * many slow retry iterations are needed.
     */
    private async waitAllAgentsSettled(): Promise<void> {
        const rounds = this.agents.length + 1;
        for (let round = 0; round < rounds; round++) {
            for (const agent of this.agents) {
                await agent.waitForSync();
            }
        }
    }

    private async assertConsistent(
        verify?: (state: AssertableState) => void
    ): Promise<void> {
        this.logger.info("Asserting all clients are consistent...");
        assert(
            this.agents.length >= 2,
            "Need at least 2 agents for consistency check"
        );

        // Snapshot all agents' file states upfront to minimize the window
        // where background sync could mutate state between reads.
        const clientFiles: Map<string, string>[] = [];
        for (const agent of this.agents) {
            const sortedFiles = (await agent.listFilesRecursively()).sort();
            const fileMap = new Map<string, string>();
            for (const file of sortedFiles) {
                const content = await agent.getFileContent(file);
                fileMap.set(file, content);
            }
            clientFiles.push(fileMap);
        }

        const referenceFiles = Array.from(clientFiles[0].keys());

        this.logger.info(
            `Reference client has ${referenceFiles.length} files: ${referenceFiles.join(", ")}`
        );

        for (let i = 1; i < clientFiles.length; i++) {
            const agentFileKeys = Array.from(clientFiles[i].keys());

            this.logger.info(
                `Client ${i} has ${agentFileKeys.length} files: ${agentFileKeys.join(", ")}`
            );

            assert(
                agentFileKeys.length === referenceFiles.length,
                `File count mismatch: client 0 has ${referenceFiles.length} files, client ${i} has ${agentFileKeys.length} files`
            );

            for (let j = 0; j < agentFileKeys.length; j++) {
                assert(
                    agentFileKeys[j] === referenceFiles[j],
                    `File list mismatch at index ${j}: client 0 has "${referenceFiles[j]}", client ${i} has "${agentFileKeys[j]}"`
                );
            }

            for (const file of referenceFiles) {
                const referenceContent = clientFiles[0].get(file);
                const agentContent = clientFiles[i].get(file);

                assert(
                    referenceContent === agentContent,
                    `Content mismatch for ${file}:\nClient 0: "${referenceContent}"\nClient ${i}: "${agentContent}"`
                );
            }
        }

        this.logger.info("✓ All clients are consistent");

        if (verify) {
            this.logger.info("Running custom verification...");
            try {
                verify(
                    new AssertableState({
                        files: clientFiles[0],
                        clientFiles
                    })
                );
            } catch (error) {
                const msg =
                    error instanceof Error ? error.message : String(error);
                throw new Error(`Custom verification failed: ${msg}`);
            }
            this.logger.info("✓ Custom verification passed");
        }
    }

    private async cleanup(): Promise<void> {
        // Always resume the server in case a test paused it and then
        // failed before reaching the resume step. Without this, all
        // subsequent tests would hang because the server process is
        // frozen (SIGSTOP) and can't respond to HTTP or WebSocket.
        try {
            this.serverControl.resume();
        } catch {
            // Server wasn't paused or isn't running — safe to ignore
        }

        this.logger.info("\nCleaning up agents...");
        for (const agent of this.agents) {
            try {
                await agent.cleanup();
            } catch (error) {
                this.logger.warn(
                    `Agent cleanup error: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
        this.agents = [];
        this.logger.info("Cleanup complete");
    }
}
