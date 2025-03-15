import type { SyncSettings } from "sync-client";
import { MockAgent } from "./agent/mock-agent";
import { sleep } from "./utils/sleep";
import { v4 as uuidv4 } from "uuid";

async function runTest({
	agentCount,
	concurrency,
	iterations,
	doDeletes,
	jitterScaleInSeconds
}: {
	agentCount: number;
	concurrency: number;
	iterations: number;
	doDeletes: boolean;
	jitterScaleInSeconds: number;
}): Promise<void> {
	const settings = `with ${agentCount} agents, concurrency ${concurrency}, iterations ${iterations}, doDeletes ${doDeletes}, jitterScaleInSeconds ${jitterScaleInSeconds}`;
	console.info(`Running test ${settings}`);

	const initialSettings: Partial<SyncSettings> = {
		isSyncEnabled: true,
		token: "token",
		vaultName: uuidv4(),
		syncConcurrency: concurrency,
		remoteUri: "http://localhost:3030"
	};

	const clients: MockAgent[] = [];
	for (let i = 0; i < agentCount; i++) {
		clients.push(
			new MockAgent(
				initialSettings,
				`agent-${i}`,
				doDeletes,
				jitterScaleInSeconds
			)
		);
	}

	// for debugging
	// eslint-disable-next-line
	(globalThis as any).clients = clients;

	try {
		await Promise.all(clients.map(async (client) => client.init()));

		for (let i = 0; i < iterations; i++) {
			console.info(`Iteration ${i + 1}/${iterations}`);
			await Promise.all(clients.map(async (client) => client.act()));
			await sleep(100);
		}

		console.info("Stopping agents");

		// Each agent can have unpushed changes which might conflict with eachother so each has to resolve the conflicts & push, and
		for (const client of clients) {
			await client.finish();
		}

		// then we need a second pass to ensure that all agents pull the same state.
		for (const client of clients) {
			await client.finish();
		}

		console.info("Agents finished successfully");

		clients.slice(0, -1).forEach((client, i) => {
			console.info(
				`Checking consistency between ${client.name} and ${clients[i + 1].name}`
			);
			client.assertFileSystemsAreConsistent(clients[i]);
			console.info(`Consistency check for ${client.name} passed`);
		});

		console.info("File systems found to be consistent");

		clients.forEach((client) => {
			console.info(`Checking content for ${client.name}`);
			client.assertAllContentIsPresentOnce();
			console.info(`Content check for ${client.name} passed`);
		});

		console.info(`Test passed ${settings}`);
	} catch (err) {
		console.error(`Test failed ${settings}`);
		throw err;
	}
}

async function runTests(): Promise<void> {
	const agentCounts = [2, 8];
	const jitterScaleInSeconds = [0.5, 0, 2];
	const concurrencies = [16, 1];
	const iterations = [50, 200];
	const doDeletes = [true, false];

	for (const agentCount of agentCounts) {
		for (const concurrency of concurrencies) {
			for (const jitter of jitterScaleInSeconds) {
				for (const iteration of iterations) {
					for (const deleteFiles of doDeletes) {
						for (let i = 0; i < 10; i++) {
							await runTest({
								agentCount,
								concurrency,
								iterations: iteration,
								doDeletes: deleteFiles,
								jitterScaleInSeconds: jitter
							});
						}
						return;
					}
				}
			}
		}
	}
}

process.on("uncaughtException", (error) => {
	console.error("Uncaught Exception:", error);
	process.exit(1);
});

process.on("unhandledRejection", (reason, _promise) => {
	console.error("Unhandled Rejection:", reason);
	process.exit(1);
});

runTests()
	.then(() => {
		process.exit(0);
	})
	.catch(async (err: unknown) => {
		console.error(err);
		process.exit(1);
	});
