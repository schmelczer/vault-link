import { v4 as uuidv4 } from "uuid";
import { DeterministicTestRunner } from "./test-runner";
import { exampleTests } from "./example-tests";

const REMOTE_URI = "http://localhost:3000";
const TOKEN = "test-token-change-me";

async function runDeterministicTests(): Promise<void> {
	console.info("=".repeat(80));
	console.info("DETERMINISTIC E2E TESTS");
	console.info("=".repeat(80));
	console.info("");

	let passed = 0;
	let failed = 0;

	for (const testDef of exampleTests) {
		// Use a unique vault for each test to avoid interference
		const vaultName = uuidv4();
		const runner = new DeterministicTestRunner(
			vaultName,
			REMOTE_URI,
			TOKEN
		);

		try {
			await runner.runTest(testDef);
			passed++;
		} catch (error) {
			failed++;
			console.error(`Test "${testDef.name}" failed with error:`, error);
		}
	}

	console.info("\n" + "=".repeat(80));
	console.info("TEST SUMMARY");
	console.info("=".repeat(80));
	console.info(`Total tests: ${exampleTests.length}`);
	console.info(`Passed: ${passed}`);
	console.info(`Failed: ${failed}`);
	console.info("=".repeat(80));

	if (failed > 0) {
		process.exit(1);
	}
}

// Error handlers
process.on("uncaughtException", (error) => {
	console.error("Uncaught exception:", error);
	process.exit(1);
});

process.on("unhandledRejection", (error) => {
	console.error("Unhandled rejection:", error);
	process.exit(1);
});

// Run tests
runDeterministicTests()
	.then(() => {
		console.info("\n✓ All deterministic tests passed!");
		process.exit(0);
	})
	.catch((error: unknown) => {
		console.error("\n✗ Deterministic tests failed:", error);
		process.exit(1);
	});
