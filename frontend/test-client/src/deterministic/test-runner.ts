import type { SyncSettings } from "sync-client";
import { debugging, Logger } from "sync-client";
import type { TestDefinition, TestEvent } from "./events";
import { DeterministicClient } from "./deterministic-client";
import { sleep } from "../utils/sleep";
import { assert } from "../utils/assert";

export class DeterministicTestRunner {
	private readonly clients = new Map<string, DeterministicClient>();
	private readonly jitterScaleInSeconds = 0.1; // Small jitter for realism

	public constructor(
		private readonly vaultName: string,
		private readonly remoteUri: string,
		private readonly token: string
	) {}

	/**
	 * Run a test definition
	 */
	public async runTest(testDef: TestDefinition): Promise<void> {
		console.info(`\n${"=".repeat(60)}`);
		console.info(`Running test: ${testDef.name}`);
		console.info(`${"=".repeat(60)}\n`);

		try {
			// Initialize clients
			await this.initializeClients(testDef.clients);

			// Execute events in sequence
			for (let i = 0; i < testDef.events.length; i++) {
				const event = testDef.events[i];
				await this.executeEvent(event, i);
			}

			console.info(`\n✓ Test passed: ${testDef.name}\n`);
		} catch (error) {
			console.error(`\n✗ Test failed: ${testDef.name}`);
			console.error(`Error: ${error}\n`);
			throw error;
		} finally {
			await this.cleanup();
		}
	}

	/**
	 * Initialize all clients for the test
	 */
	private async initializeClients(clientIds: string[]): Promise<void> {
		console.info(`Initializing ${clientIds.length} clients...`);

		for (const clientId of clientIds) {
			const settings: Partial<SyncSettings> = {
				isSyncEnabled: true,
				token: this.token,
				vaultName: this.vaultName,
				syncConcurrency: 16,
				remoteUri: this.remoteUri
			};

			const client = new DeterministicClient(clientId, settings);
			await client.init(
				debugging.slowFetchFactory(this.jitterScaleInSeconds),
				debugging.slowWebSocketFactory(
					this.jitterScaleInSeconds,
					new Logger()
				)
			);

			// Verify connection
			const connectionCheck = await client
				.getSyncClient()
				.checkConnection();
			assert(
				connectionCheck.isSuccessful,
				`Failed to connect client ${clientId}`
			);

			this.clients.set(clientId, client);
			console.info(`  ✓ Initialized client: ${clientId}`);
		}

		console.info("");
	}

	/**
	 * Execute a single event
	 */
	private async executeEvent(event: TestEvent, index: number): Promise<void> {
		const description = event.description ?? event.type;
		console.info(`[${index}] ${description}`);

		switch (event.type) {
			case "create-file": {
				const client = this.getClient(event.clientId);
				await client.createFile(
					event.path,
					event.content,
					event.immediate ?? true
				);
				break;
			}

			case "update-file": {
				const client = this.getClient(event.clientId);
				await client.updateFile(
					event.path,
					event.content,
					event.immediate ?? true
				);
				break;
			}

			case "delete-file": {
				const client = this.getClient(event.clientId);
				await client.deleteFile(event.path, event.immediate ?? true);
				break;
			}

			case "rename-file": {
				const client = this.getClient(event.clientId);
				await client.renameFile(
					event.oldPath,
					event.newPath,
					event.immediate ?? true
				);
				break;
			}

			case "append-to-file": {
				const client = this.getClient(event.clientId);
				await client.appendToFile(
					event.path,
					event.content,
					event.immediate ?? true
				);
				break;
			}

			case "flush": {
				const client = this.getClient(event.clientId);
				await client.flush();
				break;
			}

			case "wait-for-sync": {
				if (event.clientId) {
					const client = this.getClient(event.clientId);
					await client.waitForSync();
				} else {
					// Wait for all clients
					await Promise.all(
						Array.from(this.clients.values()).map(async (c) =>
							c.waitForSync()
						)
					);
				}
				break;
			}

			case "enable-sync": {
				const client = this.getClient(event.clientId);
				await client.setSyncEnabled(true);
				break;
			}

			case "disable-sync": {
				const client = this.getClient(event.clientId);
				await client.setSyncEnabled(false);
				break;
			}

			case "sleep": {
				await sleep(event.milliseconds);
				break;
			}

			case "assert-file-exists": {
				const client = this.getClient(event.clientId);
				await client.assertFileExists(event.path, event.shouldExist);
				console.info(
					`  ✓ Assertion passed: ${event.path} ${event.shouldExist ? "exists" : "doesn't exist"}`
				);
				break;
			}

			case "assert-file-content": {
				const client = this.getClient(event.clientId);
				await client.assertFileContent(
					event.path,
					event.expectedContent
				);
				console.info(
					`  ✓ Assertion passed: ${event.path} has expected content`
				);
				break;
			}

			case "assert-file-count": {
				const client = this.getClient(event.clientId);
				await client.assertFileCount(event.expectedCount);
				console.info(
					`  ✓ Assertion passed: ${event.expectedCount} files`
				);
				break;
			}

			case "assert-all-clients-consistent": {
				const clientList = Array.from(this.clients.values());
				for (let i = 0; i < clientList.length - 1; i++) {
					await clientList[i].assertConsistentWith(clientList[i + 1]);
				}
				console.info(`  ✓ Assertion passed: all clients consistent`);
				break;
			}

			case "assert-clients-consistent": {
				const clientList = event.clientIds.map((id) =>
					this.getClient(id)
				);
				for (let i = 0; i < clientList.length - 1; i++) {
					await clientList[i].assertConsistentWith(clientList[i + 1]);
				}
				console.info(
					`  ✓ Assertion passed: clients ${event.clientIds.join(", ")} consistent`
				);
				break;
			}

			default: {
				// @ts-expect-error - exhaustive check
				throw new Error(`Unknown event type: ${event.type}`);
			}
		}
	}

	/**
	 * Get a client by ID
	 */
	private getClient(clientId: string): DeterministicClient {
		const client = this.clients.get(clientId);
		if (!client) {
			throw new Error(`Client ${clientId} not found`);
		}
		return client;
	}

	/**
	 * Cleanup all clients
	 */
	private async cleanup(): Promise<void> {
		console.info("Cleaning up clients...");
		for (const [id, client] of this.clients) {
			try {
				await client.destroy();
				console.info(`  ✓ Destroyed client: ${id}`);
			} catch (error) {
				console.error(`  ✗ Failed to destroy client ${id}: ${error}`);
			}
		}
		this.clients.clear();
	}
}
