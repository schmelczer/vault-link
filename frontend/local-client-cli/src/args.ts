import { Command } from "commander";
import packageJson from "../package.json";

export interface CliArgs {
	remoteUri: string;
	token: string;
	vaultName: string;
	localPath: string;
	syncConcurrency?: number;
	maxFileSizeMB?: number;
	ignorePatterns?: string[];
	webSocketRetryIntervalMs?: number;
}

export function parseArgs(argv: string[]): CliArgs {
	const program = new Command();

	program
		.name("vaultlink")
		.description(
			"VaultLink Local CLI - Sync your vault to the local filesystem"
		)
		.version(packageJson.version)
		.exitOverride((err) => {
			// Let help and version exit normally
			if (
				err.code === "commander.helpDisplayed" ||
				err.code === "commander.version"
			) {
				process.exit(0);
			}
			throw err;
		})
		.requiredOption(
			"-l, --local-path <path>",
			"Local directory path to sync"
		)
		.option("-r, --remote-uri <uri>", "Remote server URI")
		.option("-t, --token <token>", "Authentication token")
		.option("-v, --vault-name <name>", "Vault name")
		.option(
			"--sync-concurrency <number>",
			"[OPTIONAL] Number of concurrent sync operations",
			parseInt
		)
		.option(
			"--max-file-size-mb <number>",
			"[OPTIONAL] Maximum file size in MB",
			parseInt
		)
		.option(
			"--ignore-pattern <pattern...>",
			"[OPTIONAL] Patterns to ignore (can be specified multiple times)"
		)
		.option(
			"--websocket-retry-interval-ms <number>",
			"[OPTIONAL] WebSocket retry interval in milliseconds",
			parseInt
		)
		.addHelpText(
			"after",
			`
Examples:
  $ vaultlink -l ./my-vault -r https://sync.example.com -t mytoken -v default
  $ vaultlink -l ./my-vault -r https://sync.example.com -t mytoken -v default \\
      --ignore-pattern ".git/**" --ignore-pattern "*.tmp"
`
		);

	program.parse(argv);

	const options = program.opts<{
		localPath: string;
		remoteUri?: string;
		token?: string;
		vaultName?: string;
		syncConcurrency?: number;
		maxFileSizeMb?: number;
		ignorePattern?: string[];
		websocketRetryIntervalMs?: number;
	}>();

	if (options.remoteUri === undefined) {
		throw new Error("required option '--remote-uri <uri>' not specified");
	}
	if (options.token === undefined) {
		throw new Error("required option '--token <token>' not specified");
	}
	if (options.vaultName === undefined) {
		throw new Error("required option '--vault-name <name>' not specified");
	}

	return {
		localPath: options.localPath,
		remoteUri: options.remoteUri ?? "",
		token: options.token ?? "",
		vaultName: options.vaultName ?? "",
		syncConcurrency: options.syncConcurrency,
		maxFileSizeMB: options.maxFileSizeMb,
		ignorePatterns: options.ignorePattern,
		webSocketRetryIntervalMs: options.websocketRetryIntervalMs
	};
}
