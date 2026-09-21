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
import { assertCanonical } from "../../test-support/canonical";
import { ContentLedger } from "../../test-support/oracles";

export class TestRunner {
    private agents: DeterministicAgent[] = [];
    private readonly serverControl: ServerControl;
    private readonly token: string;
    private readonly remoteUri: string;
    private readonly logger: Logger;
    private vaultName = "";
    private readonly identities = new Map<string, string>();

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
        this.identities.clear();
        let diagnostics: TestResult["diagnostics"];

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

            assert(
                this.serverControl.isRunning(),
                "Server died before test completion"
            );
            diagnostics = this.captureDiagnostics();
            await this.cleanup();

            const duration = Date.now() - startTime;
            this.logger.info(`\n✓ Test passed: ${name} (${duration}ms)`);

            return {
                success: true,
                duration
            };
        } catch (error) {
            diagnostics ??= this.captureDiagnostics();
            const duration = Date.now() - startTime;
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.logger.info(`\n✗ Test failed: ${name}`);
            this.logger.info(`Error: ${errorMessage}`);

            try {
                await this.cleanup();
            } catch (cleanupError) {
                return {
                    success: false,
                    error: `${errorMessage}\nCleanup: ${String(cleanupError)}`,
                    duration,
                    diagnostics
                };
            }

            return {
                success: false,
                error: errorMessage,
                diagnostics,
                duration
            };
        }
    }

    private captureDiagnostics(): unknown {
        return this.agents.map((agent) => ({
            client: agent.clientId,
            database: agent.database(),
            disk: agent.disk.image(),
            requests: structuredClone(agent.network.requests)
        }));
    }

    private async initializeAgents(count: number): Promise<void> {
        assert(count > 0, `Client count must be positive, got ${count}`);
        const vaultName = `test-${randomUUID()}`;
        this.vaultName = vaultName;
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
            case "pause-observation":
                this.getAgent(step.client).pauseObservation();
                break;
            case "resume-observation":
                this.getAgent(step.client).resumeObservation();
                break;
            case "wait-for-observation":
                await this.getAgent(step.client).waitForObservation();
                break;
            case "create-bytes":
                await this.getAgent(step.client).write(
                    step.path,
                    new Uint8Array(step.bytes)
                );
                break;
            case "drop-response":
                this.getAgent(step.client).dropNextResponse(
                    step.kind,
                    step.point
                );
                break;
            case "wait-for-response-drop":
                await this.getAgent(step.client).waitForDroppedCreateResponse();
                break;
            case "delay-notifications":
                this.getAgent(step.client).delayNotifications();
                break;
            case "flush-notifications":
                this.getAgent(step.client).flushNotifications();
                break;
            case "remember-identity":
            case "assert-identity":
                await this.assertConsistent((state) => {
                    if (step.type === "remember-identity")
                        this.identities.set(
                            step.key,
                            state.documentId(step.path)
                        );
                    else {
                        const id = this.identities.get(step.key);
                        assert(
                            id !== undefined,
                            `Identity ${step.key} was never recorded`
                        );
                        state.assertIdentity(step.path, id);
                    }
                });
                break;
            case "assert-files":
                await this.assertConsistent((state) => {
                    for (const [path, value] of Object.entries(step.expected))
                        state.assertContent(path, value);
                    for (const path of step.absent ?? [])
                        state.assertFileNotExists(path);
                    if (step.count !== undefined)
                        state.assertFileCount(step.count);
                });
                break;
            case "assert-documents":
                await this.assertConsistent((state) =>
                    state.assertDocuments(step.expected, this.identities)
                );
                break;
            case "assert-markers": {
                const ledger = new ContentLedger();
                for (const marker of step.markers) ledger.add(marker);
                for (const marker of step.removed ?? [])
                    ledger.removedBy(
                        marker,
                        "trace records explicit deletion/overwrite"
                    );
                for (const agent of this.agents)
                    ledger.assertPreserved(agent.files());
                break;
            }
            case "crash-server":
                await this.serverControl.crash();
                break;
            case "restart-server":
                await this.serverControl.restart();
                break;
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
                await this.getAgent(step.client).enableSync(
                    !this.serverControl.isPaused
                );
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
                    () => {
                        this.serverControl.pause();
                    }
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

        throw new Error(
            `Convergence timed out after ${CONVERGENCE_TIMEOUT_MS}ms: ${lastError?.message ?? "no consistency check ran"}`,
            { cause: lastError }
        );
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
        const canonical = await assertCanonical(
            this.agents,
            `${this.remoteUri}/vaults/${encodeURIComponent(this.vaultName)}`,
            this.token
        );
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
                        clientFiles,
                        manifests: this.agents.map(
                            (agent) => agent.database()!.local!
                        ),
                        canonical: canonical.fileManifest.entries,
                        bytes: this.agents[0].files()
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
        const errors: unknown[] = [];
        for (const agent of this.agents.splice(0)) {
            try {
                await agent.cleanup();
            } catch (error) {
                errors.push(error);
                this.logger.warn(
                    `Agent cleanup error: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
        this.agents = [];
        this.logger.info("Cleanup complete");
        if (errors.length)
            throw new AggregateError(
                errors,
                `Cleanup failed: ${errors.map(String).join("; ")}`
            );
    }
}
