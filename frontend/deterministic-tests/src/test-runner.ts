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
            // Initialize agents
            await this.initializeAgents(test.clients);

            // Execute steps
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
        const vaultName = `test-${randomUUID()}`;
        this.logger.info(
            `Initializing ${count} agents with vault: ${vaultName}`
        );

        const settings: Partial<SyncSettings> = {
            isSyncEnabled: false,
            token: this.token,
            vaultName,
            syncConcurrency: 1,
            remoteUri: this.remoteUri
        };

        for (let i = 0; i < count; i++) {
            const agent = new DeterministicAgent(i, settings, (msg) => {
                this.logger.info(msg);
            });

            await agent.init(
                fetch,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                WebSocket as unknown as typeof globalThis.WebSocket
            );
            this.agents.push(agent);
            this.logger.info(`Initialized client ${i}`);
        }

        this.logger.info("All agents initialized");
    }

    private async executeStep(step: TestStep): Promise<void> {
        switch (step.type) {
            case "create":
                await this.agents[step.client].createFile(
                    step.path,
                    step.content
                );
                break;

            case "update":
                await this.agents[step.client].updateFile(
                    step.path,
                    step.content
                );
                break;

            case "rename":
                await this.agents[step.client].renameFile(
                    step.oldPath,
                    step.newPath
                );
                break;

            case "delete":
                await this.agents[step.client].deleteFile(step.path);
                break;

            case "sync":
                if (step.client !== undefined) {
                    await this.agents[step.client].waitForSync();
                } else {
                    for (const agent of this.agents) {
                        await agent.waitForSync();
                    }
                }
                break;

            case "disable-sync":
                await this.agents[step.client].disableSync();
                break;

            case "enable-sync":
                await this.agents[step.client].enableSync();
                break;

            case "pause-server":
                this.serverControl.pause();
                break;

            case "resume-server":
                this.serverControl.resume();
                break;

            case "barrier":
                await this.waitForConvergence();
                break;

            case "assert-content":
                await this.agents[step.client].assertContent(
                    step.path,
                    step.content
                );
                break;

            case "assert-exists":
                await this.agents[step.client].assertExists(step.path);
                break;

            case "assert-not-exists":
                await this.agents[step.client].assertNotExists(step.path);
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

    private async waitForConvergence(): Promise<void> {
        this.logger.info("Barrier: waiting for convergence...");

        for (const agent of this.agents) {
            await agent.waitForSync();
        }

        if (await this.checkConsistency()) {
            this.logger.info("Barrier complete: all clients converged");
            return;
        }

        throw new Error(
            `Clients did not converge`
        );
    }

    private async checkConsistency(): Promise<boolean> {
        const [referenceAgent] = this.agents;
        const referenceFiles = (await referenceAgent.getFiles()).sort();

        for (let i = 1; i < this.agents.length; i++) {
            const agent = this.agents[i];
            const files = (await agent.getFiles()).sort();

            if (files.length !== referenceFiles.length) {
                throw new Error(
                    `File count mismatch: client 0 has ${referenceFiles.length} files, client ${i} has ${files.length} files.\n Files: ${files.join(", ")}\n Reference: ${referenceFiles.join(", ")}`
                );
            }

            for (const file of referenceFiles) {
                const referenceContent =
                    await referenceAgent.getFileContent(file);
                const agentContent = await agent.getFileContent(file);

                if (referenceContent !== agentContent) {
                    throw new Error(
                        `Content mismatch for ${file}:\nReference: "${referenceContent}"\nClient ${i}: "${agentContent}"`
                    );
                }
            }
        }

        return true;
    }

    private async assertConsistent(
        verify?: (state: ClientState) => void
    ): Promise<void> {
        this.logger.info("Asserting all clients are consistent...");

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
            verify(referenceState);
            this.logger.info("✓ Custom verification passed");
        }
    }

    private async cleanup(): Promise<void> {
        this.logger.info("\nCleaning up agents...");
        for (const agent of this.agents) {
            await agent.cleanup();
        }
        this.agents = [];
        this.logger.info("Cleanup complete");
    }
}
