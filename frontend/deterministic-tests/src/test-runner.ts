import type { TestDefinition, TestResult, TestStep } from "./test-definition";
import { DeterministicAgent } from "./deterministic-agent";
import type { ServerControl } from "./server-control";
import type { SyncSettings } from "sync-client";
import { utils } from "sync-client";
import { sleep } from "./utils/sleep";
import { assert } from "./utils/assert";
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

export class TestRunner {
    private agents: DeterministicAgent[] = [];
    private readonly serverControl: ServerControl;
    private readonly token: string;
    private readonly remoteUri: string;
    private readonly logBuffer: string[] = [];

    public constructor(
        serverControl: ServerControl,
        options: {
            token?: string;
            remoteUri?: string;
        } = {}
    ) {
        this.serverControl = serverControl;
        this.token = options.token ?? "test-token-change-me     ";
        this.remoteUri = options.remoteUri ?? "http://localhost:3000";
    }

    public async runTest(test: TestDefinition): Promise<TestResult> {
        const startTime = Date.now();
        this.log(`\n${"=".repeat(80)}`);
        this.log(`Running test: ${test.name}`);
        if (test.description !== undefined && test.description !== "") {
            this.log(`Description: ${test.description}`);
        }
        this.log(`Clients: ${test.clients}`);
        this.log(`Steps: ${test.steps.length}`);
        this.log("=".repeat(80));

        try {
            // Initialize agents
            await this.initializeAgents(test.clients);

            // Execute steps
            for (let i = 0; i < test.steps.length; i++) {
                const step = test.steps[i];
                this.log(
                    `\nStep ${i + 1}/${test.steps.length}: ${JSON.stringify(step)}`
                );
                await this.executeStep(step);
            }

            // Cleanup
            await this.cleanup();

            const duration = Date.now() - startTime;
            this.log(`\n✓ Test passed: ${test.name} (${duration}ms)`);

            return {
                success: true,
                duration
            };
        } catch (error) {
            const duration = Date.now() - startTime;
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            this.log(`\n✗ Test failed: ${test.name}`);
            this.log(`Error: ${errorMessage}`);

            await this.cleanup();

            return {
                success: false,
                error: errorMessage,
                duration
            };
        }
    }

    public getLog(): string {
        return this.logBuffer.join("\n");
    }

    private log(message: string): void {
        const timestamp = new Date().toISOString();
        const logLine = `[${timestamp}] ${message}`;
        console.log(logLine);
        this.logBuffer.push(logLine);
    }

    private async initializeAgents(count: number): Promise<void> {
        // Use unique vault name for each test run to avoid data interference
        const vaultName = `test-${randomUUID()}`;
        this.log(`\nInitializing ${count} agents with vault: ${vaultName}`);

        const settings: Partial<SyncSettings> = {
            // Start with sync disabled to avoid scheduleSyncForOfflineChanges running
            // before we've created our test files. Tests must explicitly enable sync.
            isSyncEnabled: false,
            token: this.token,
            vaultName,
            syncConcurrency: 1,
            remoteUri: this.remoteUri
        };

        for (let i = 0; i < count; i++) {
            const agent = new DeterministicAgent(i, settings, (msg) => {
                this.log(msg);
            });
            // WebSocket from 'ws' package needs type assertion for browser WebSocket interface

            await agent.init(
                fetch,
                // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
                WebSocket as unknown as typeof globalThis.WebSocket
            );
            this.agents.push(agent);
            this.log(`Initialized client ${i}`);
        }

        // Wait for WebSocket connections to fully establish
        await sleep(100);
        this.log("All agents initialized and connected");
        // Note: Sync is disabled on all agents. Tests must explicitly enable sync.
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
                    // Wait for all clients
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

            case "wait":
                this.log(`Waiting ${step.duration}ms...`);
                await sleep(step.duration);
                break;

            case "pause-server":
                this.serverControl.pause();
                break;

            case "resume-server":
                this.serverControl.resume();
                break;

            case "barrier":
                this.log(
                    "Barrier: waiting for all clients to finish pending operations..."
                );
                // First, wait for all local pending operations to complete
                for (const agent of this.agents) {
                    await agent.waitForSync();
                }

                // Wait for network propagation
                await sleep(500);

                // Then sync again to ensure all clients have received updates from others
                for (const agent of this.agents) {
                    await agent.waitForSync();
                }
                this.log("Barrier complete");
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
                await this.assertConsistent();
                break;

            default: {
                const unknownStep = step as { type: string };
                throw new Error(`Unknown step type: ${unknownStep.type}`);
            }
        }
    }

    private async assertConsistent(): Promise<void> {
        this.log("Asserting all clients are consistent...");

        if (this.agents.length < 2) {
            this.log("Only one client, skipping consistency check");
            return;
        }

        const [referenceAgent] = this.agents;
        const referenceFiles = (await referenceAgent.getFiles()).sort();

        this.log(
            `Reference client has ${referenceFiles.length} files: ${referenceFiles.join(", ")}`
        );

        for (let i = 1; i < this.agents.length; i++) {
            const agent = this.agents[i];
            const files = (await agent.getFiles()).sort();

            this.log(
                `Client ${i} has ${files.length} files: ${files.join(", ")}`
            );

            // Check file lists match
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

            // Check file contents match
            for (const file of referenceFiles) {
                const referenceContent =
                    await referenceAgent.getFileContent(file);
                const agentContent = await agent.getFileContent(file);

                assert(
                    referenceContent === agentContent,
                    `Content mismatch for ${file}:\nClient 0: "${referenceContent}"\nClient ${i}: "${agentContent}"`
                );
            }
        }

        this.log("✓ All clients are consistent");
    }

    private async cleanup(): Promise<void> {
        this.log("\nCleaning up agents...");
        for (const agent of this.agents) {
            await agent.cleanup();
        }
        this.agents = [];
        this.log("Cleanup complete");
    }
}
