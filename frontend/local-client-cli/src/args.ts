import { Command } from "commander";
import packageJson from "../package.json";
import { LogLevel } from "sync-client";

export interface CliArgs {
    remoteUri: string;
    token: string;
    vaultName: string;
    localPath: string;
    syncConcurrency?: number;
    maxFileSizeMB?: number;
    ignorePatterns?: string[];
    webSocketRetryIntervalMs?: number;
    logLevel: LogLevel;
    health?: string;
    enableTelemetry?: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
    const program = new Command();

    program
        .name("vaultlink")
        .description(
            "VaultLink Local CLI - Sync your vault to the local filesystem"
        )
        .version(packageJson.version)
        .option("-l, --local-path <path>", "Local directory path to sync")
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
        .option(
            "--log-level <level>",
            "[OPTIONAL] Log level (DEBUG, INFO, WARNING, ERROR)",
            "INFO"
        )
        .option(
            "--health <path>",
            "[OPTIONAL] Path to health status file for Docker healthcheck"
        )
        .option(
            "--enable-telemetry",
            "[OPTIONAL] Enable telemetry (disabled by default)"
        )
        .addHelpText(
            "after",
            `
Examples:
  $ vaultlink -l ./my-vault -r https://sync.example.com -t mytoken -v default
  $ vaultlink -l ./my-vault -r https://sync.example.com -t mytoken -v default \\
    --ignore-pattern ".git/**" --ignore-pattern "*.tmp"
  $ vaultlink -l ./my-vault -r https://sync.example.com -t mytoken -v default \\
    --log-level DEBUG
`
        );

    program.parse(argv);

    /* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
    const opts = program.opts();
    const localPath = opts.localPath as string | undefined;
    const remoteUri = opts.remoteUri as string | undefined;
    const token = opts.token as string | undefined;
    const vaultName = opts.vaultName as string | undefined;
    const syncConcurrency = opts.syncConcurrency as number | undefined;
    const maxFileSizeMb = opts.maxFileSizeMb as number | undefined;
    const ignorePattern = opts.ignorePattern as string[] | undefined;
    const websocketRetryIntervalMs = opts.websocketRetryIntervalMs as
        | number
        | undefined;
    const logLevelStr = (opts.logLevel as string | undefined) ?? "INFO";
    const health = opts.health as string | undefined;
    const enableTelemetry = opts.enableTelemetry as boolean | undefined;
    /* eslint-enable @typescript-eslint/no-unsafe-type-assertion */

    if (localPath === undefined) {
        throw new Error(
            "required option '-l, --local-path <path>' not specified"
        );
    }
    if (remoteUri === undefined) {
        throw new Error("required option '--remote-uri <uri>' not specified");
    }
    if (token === undefined) {
        throw new Error("required option '--token <token>' not specified");
    }
    if (vaultName === undefined) {
        throw new Error("required option '--vault-name <name>' not specified");
    }

    // Validate and parse log level
    const logLevelUpper = logLevelStr.toUpperCase();
    const validLogLevels = Object.values(LogLevel);
    const isLogLevel = (value: string): value is LogLevel => {
        return (validLogLevels as readonly string[]).includes(value);
    };
    if (!isLogLevel(logLevelUpper)) {
        throw new Error(
            `Invalid log level '${logLevelStr}'. Valid values are: ${validLogLevels.join(", ")}`
        );
    }
    const logLevel = logLevelUpper;

    return {
        localPath,
        remoteUri,
        token,
        vaultName,
        syncConcurrency,
        maxFileSizeMB: maxFileSizeMb,
        ignorePatterns: ignorePattern,
        webSocketRetryIntervalMs: websocketRetryIntervalMs,
        logLevel,
        health,
        enableTelemetry
    };
}
