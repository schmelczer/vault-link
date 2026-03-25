import type {
    TestDefinition,
    TestResult,
    TestStep,
    ClientState
} from "./test-definition";
import { DeterministicAgent } from "./deterministic-agent";
import type { ServerControl } from "./server-control";
import type { SyncSettings, Logger } from "sync-client";
import { assert } from "./utils/assert";
import { sleep } from "./utils/sleep";
import { withTimeout } from "./utils/with-timeout";
import {
    CONVERGENCE_TIMEOUT_MS,
    CONVERGENCE_RETRY_DELAY_MS,
    AGENT_INIT_TIMEOUT_MS,
    IS_SYNC_ENABLED_DEFAULT
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

    public async runTest(test: TestDefinition): Promise<TestResult> {
        const startTime = Date.now();
        this.logger.info(`Running test: ${test.name}`);
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
            this.logger.info(`\n✓ Test passed: ${test.name} (${duration}ms)`);

            return {
                success: true,
                duration
            };
        } catch (error) {
            const duration = Date.now() - startTime;
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.logger.info(`\n✗ Test failed: ${test.name}`);
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
                isSyncEnabled: IS_SYNC_ENABLED_DEFAULT,
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
                agent.init(
                    fetch,
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                    WebSocket as unknown as typeof globalThis.WebSocket
                ),
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
                await this.getAgent(step.client).createFile(
                    step.path,
                    step.content
                );
                break;

            case "update":
                await this.getAgent(step.client).updateFile(
                    step.path,
                    step.content
                );
                break;

            case "rename":
                await this.getAgent(step.client).renameFile(
                    step.oldPath,
                    step.newPath
                );
                break;

            case "delete":
                await this.getAgent(step.client).deleteFile(step.path);
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

            case "barrier":
                await this.waitForConvergence();
                break;

            case "assert-content":
                await this.getAgent(step.client).assertContent(
                    step.path,
                    step.content
                );
                break;

            case "assert-exists":
                await this.getAgent(step.client).assertExists(step.path);
                break;

            case "assert-not-exists":
                await this.getAgent(step.client).assertNotExists(step.path);
                break;

            case "assert-consistent":
                await this.assertConsistent(step.verify);
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
     * Wait for all agents to be simultaneously idle. Two full rounds are
     * needed because completing work on agent A can trigger a server
     * broadcast that enqueues new work on agent B, and vice versa.
     * 
     * However, the 2nd sync may result in merges which can trigger another
     * round of syncs, so this function should be called in a loop with a
     * timeout to ensure true convergence rather than just waiting for the
     * current round of syncs to complete.
     */
    private async waitAllAgentsSettled(): Promise<void> {
        for (let round = 0; round < 2; round++) {
            for (const agent of this.agents) {
                await agent.waitForSync();
            }
        }
    }

    private async assertConsistent(
        verify?: (state: ClientState) => void
    ): Promise<void> {
        this.logger.info("Asserting all clients are consistent...");
        assert(this.agents.length >= 2, "Need at least 2 agents for consistency check");

        const [referenceAgent] = this.agents;
        const referenceFiles = (await referenceAgent.getFiles()).sort();
        const referenceState: ClientState = { files: new Map() };

        for (const file of referenceFiles) {
            const content = await referenceAgent.getFileContent(file);
            referenceState.files.set(file, content);
        }

        this.logger.info(
            `Reference client has ${referenceFiles.length} files: ${referenceFiles.join(", ")}`
        );

        for (let i = 1; i < this.agents.length; i++) {
            const agent = this.agents[i];
            const files = (await agent.getFiles()).sort();

            this.logger.info(
                `Client ${i} has ${files.length} files: ${files.join(", ")}`
            );

            assert(
                files.length === referenceFiles.length,
                `File count mismatch: client 0 has ${referenceFiles.length} files, client ${i} has ${files.length} files`
            );

            for (let j = 0; j < files.length; j++) {
                assert(
                    files[j] === referenceFiles[j],
                    `File list mismatch at index ${j}: client 0 has "${referenceFiles[j]}", client ${i} has "${files[j]}"`
                );
            }

            for (const file of referenceFiles) {
                const referenceContent = referenceState.files.get(file);
                const agentContent = await agent.getFileContent(file);

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
                verify(referenceState);
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
