import * as path from "path";
import * as fs from "fs/promises";
import {
	SyncClient,
	DEFAULT_SETTINGS,
	type SyncSettings,
	type StoredDatabase
} from "sync-client";
import { parseArgs } from "./args";
import { NodeFileSystemOperations } from "./node-filesystem";
import { FileWatcher } from "./file-watcher";
import { formatLogLine, colorize, styleText } from "./logger-formatter";
import packageJson from "../package.json";

async function main(): Promise<void> {
	const args = parseArgs(process.argv);
	const absolutePath = path.resolve(args.localPath);

	try {
		const stats = await fs.stat(absolutePath);
		if (!stats.isDirectory()) {
			console.error(
				colorize(`Error: ${absolutePath} is not a directory`, "red")
			);
			process.exit(1);
		}
	} catch (error) {
		console.error(
			colorize(
				`Error: Cannot access directory ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
				"red"
			)
		);
		process.exit(1);
	}

	// Print header with colors
	console.log(
		styleText("VaultLink Local CLI", "bold", "cyan") +
			colorize(` v${packageJson.version}`, "dim")
	);
	console.log(colorize("=".repeat(50), "dim"));
	console.log(
		`${colorize("Local path:", "dim")} ${colorize(absolutePath, "green")}`
	);
	console.log(
		`${colorize("Remote URI:", "dim")} ${colorize(args.remoteUri, "cyan")}`
	);
	console.log(
		`${colorize("Vault name:", "dim")} ${colorize(args.vaultName, "green")}`
	);
	console.log("");

	const dataDir = path.join(absolutePath, ".vaultlink");
	const dataFile = path.join(dataDir, "sync-data.json");

	await fs.mkdir(dataDir, { recursive: true });

	const fileSystem = new NodeFileSystemOperations(absolutePath);

	const ignorePatterns = [
		...(args.ignorePatterns ?? []),
		".vaultlink/**",
		".git/**"
	];

	const settings: SyncSettings = {
		remoteUri: args.remoteUri,
		token: args.token,
		vaultName: args.vaultName,
		syncConcurrency:
			args.syncConcurrency ?? DEFAULT_SETTINGS.syncConcurrency,
		maxFileSizeMB: args.maxFileSizeMB ?? DEFAULT_SETTINGS.maxFileSizeMB,
		ignorePatterns,
		webSocketRetryIntervalMs:
			args.webSocketRetryIntervalMs ??
			DEFAULT_SETTINGS.webSocketRetryIntervalMs,
		isSyncEnabled: true
	};

	const client = await SyncClient.create({
		fs: fileSystem,
		persistence: {
			load: async () => {
				let database: Partial<StoredDatabase> | undefined = undefined;
				try {
					const content = await fs.readFile(dataFile, "utf-8");
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
					database = JSON.parse(content) as Partial<StoredDatabase>;
				} catch {
					console.error(
						colorize(
							`Cannot read data file at ${dataFile}`,
							"yellow"
						)
					);
				}

				return {
					settings,
					database
				};
			},
			save: async ({ database: persistedDatabase }) => {
				// settings can't be updated when running with this CLI
				await fs.writeFile(
					dataFile,
					JSON.stringify(persistedDatabase, null, 2)
				);
			}
		},
		nativeLineEndings: process.platform === "win32" ? "\r\n" : "\n"
	});

	// Add colored log formatter
	client.logger.addOnMessageListener((logLine) => {
		console.log(formatLogLine(logLine));
	});

	client.logger.info("Starting sync client");

	const fileWatcher = new FileWatcher(absolutePath, client);

	client.addWebSocketStatusChangeListener(() => {
		const currentSettings = client.getSettings();
		if (currentSettings.isSyncEnabled) {
			client.logger.info("WebSocket status changed");
		}
	});

	client.addRemainingSyncOperationsListener((remaining) => {
		if (remaining === 0) {
			client.logger.info("All sync operations completed");
		} else {
			client.logger.info(`${remaining} sync operations remaining`);
		}
	});

	const gracefulShutdown = async (signal: string): Promise<void> => {
		console.log(
			colorize(
				`\n${signal} received. Shutting down gracefully...`,
				"yellow"
			)
		);
		fileWatcher.stop();
		await client.waitAndStop();
		console.log(colorize("Shutdown complete", "green"));
		process.exit(0);
	};

	process.on("SIGINT", () => {
		void gracefulShutdown("SIGINT");
	});
	process.on("SIGTERM", () => {
		void gracefulShutdown("SIGTERM");
	});

	try {
		const connectionStatus = await client.checkConnection();
		if (!connectionStatus.isSuccessful) {
			console.error(
				colorize(
					`Error: Cannot connect to server: ${connectionStatus.serverMessage}`,
					"red"
				)
			);
			process.exit(1);
		}

		console.log(`${colorize("✓", "green")} Server connection successful`);
		console.log("");

		await client.start();
		fileWatcher.start();

		console.log(styleText("✓ Sync started", "bold", "green"));
		console.log(colorize("Press Ctrl+C to stop", "dim"));
		console.log(colorize("─".repeat(50), "dim"));
		console.log("");

		await new Promise<void>(() => {
			// Keep process alive until signal received
		});
	} catch (error) {
		console.error(
			colorize(
				`Fatal error: ${error instanceof Error ? error.message : String(error)}`,
				"red"
			)
		);
		fileWatcher.stop();
		await client.waitAndStop();
		process.exit(1);
	}
}

main().catch((error: unknown) => {
	console.error(
		colorize(
			`Unexpected error: ${error instanceof Error ? error.message : String(error)}`,
			"red"
		)
	);
	process.exit(1);
});
