import { Command, Option } from "commander";
import packageJson from "../package.json";
import { LogLevel } from "sync-client";

type LineEndingMode = "auto" | "lf" | "crlf";

interface CliArgs {
    remoteUri: string;
    token: string;
    vaultName: string;
    localPath: string;
    maxFileSizeMB?: number;
    ignorePatterns?: string[];
    webSocketRetryIntervalMs?: number;
    logLevel: LogLevel;
    health?: string;
    enableTelemetry?: boolean;
    quiet: boolean;
    lineEndings: LineEndingMode;
}

const VALID_PROTOCOLS = ["http://", "https://", "ws://", "wss://"];

export function parseArgs(argv: string[]): CliArgs {
    const program = new Command();

    program
        .name("vaultlink")
        .description(
            "VaultLink Local CLI - Sync your vault to the local filesystem"
        )
        .version(packageJson.version)
        .addOption(
            new Option(
                "-l, --local-path <path>",
                "Local directory path to sync"
            ).env("VAULTLINK_LOCAL_PATH")
        )
        .addOption(
            new Option("-r, --remote-uri <uri>", "Remote server URI").env(
                "VAULTLINK_REMOTE_URI"
            )
        )
        .addOption(
            new Option("-t, --token <token>", "Authentication token").env(
                "VAULTLINK_TOKEN"
            )
        )
        .addOption(
            new Option("-v, --vault-name <name>", "Vault name").env(
                "VAULTLINK_VAULT_NAME"
            )
        )
        .addOption(
            new Option(
                "--max-file-size-mb <number>",
                "[OPTIONAL] Maximum file size in MB"
            )
                .argParser(parseInt)
                .env("VAULTLINK_MAX_FILE_SIZE_MB")
        )
        .addOption(
            new Option(
                "--ignore-pattern <pattern...>",
                "[OPTIONAL] Patterns to ignore (can be specified multiple times)"
            ).env("VAULTLINK_IGNORE_PATTERNS")
        )
        .addOption(
            new Option(
                "--websocket-retry-interval-ms <number>",
                "[OPTIONAL] WebSocket retry interval in milliseconds"
            )
                .argParser(parseInt)
                .env("VAULTLINK_WEBSOCKET_RETRY_INTERVAL_MS")
        )
        .addOption(
            new Option(
                "--log-level <level>",
                "[OPTIONAL] Log level (DEBUG, INFO, WARNING, ERROR)"
            )
                .default("INFO")
                .env("VAULTLINK_LOG_LEVEL")
        )
        .addOption(
            new Option(
                "--health <path>",
                "[OPTIONAL] Path to health status file for Docker healthcheck"
            ).env("VAULTLINK_HEALTH")
        )
        .addOption(
            new Option(
                "--enable-telemetry",
                "[OPTIONAL] Enable telemetry (disabled by default)"
            ).env("VAULTLINK_ENABLE_TELEMETRY")
        )
        .addOption(
            new Option(
                "-q, --quiet",
                "[OPTIONAL] Suppress startup banner for non-interactive use"
            ).env("VAULTLINK_QUIET")
        )
        .addOption(
            new Option(
                "--line-endings <mode>",
                "[OPTIONAL] Line ending style: auto (platform default), lf, crlf"
            )
                .default("auto")
                .choices(["auto", "lf", "crlf"])
                .env("VAULTLINK_LINE_ENDINGS")
        )
        .addHelpText(
            "after",
            `
Examples:
  $ vaultlink -l ./my-vault -r https://sync.example.com -t mytoken -v default
  $ vaultlink -l ./my-vault -r https://sync.example.com -t mytoken -v default \\
    --ignore-pattern ".git/**" --ignore-pattern "**/*.tmp"
  $ vaultlink -l ./my-vault -r https://sync.example.com -t mytoken -v default \\
    --log-level DEBUG --quiet

Environment variables:
  All options can be configured via VAULTLINK_ prefixed environment variables.
  CLI arguments take precedence over environment variables.
`
        );

    program.parse(argv);

    /* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
    const opts = program.opts();
    const localPath = opts.localPath as string | undefined;
    const remoteUri = opts.remoteUri as string | undefined;
    const token = opts.token as string | undefined;
    const vaultName = opts.vaultName as string | undefined;
    const maxFileSizeMb = opts.maxFileSizeMb as number | undefined;
    const ignorePattern = opts.ignorePattern as string[] | undefined;
    const websocketRetryIntervalMs = opts.websocketRetryIntervalMs as
        | number
        | undefined;
    const logLevelStr = (opts.logLevel as string | undefined) ?? "INFO";
    const health = opts.health as string | undefined;
    const enableTelemetry = opts.enableTelemetry as boolean | undefined;
    const quiet = (opts.quiet as boolean | undefined) ?? false;
    const lineEndingsStr = (opts.lineEndings as string | undefined) ?? "auto";
    /* eslint-enable @typescript-eslint/no-unsafe-type-assertion */

    const requireOption = <T>(value: T | undefined, name: string): T => {
        if (value === undefined) {
            const option = program.options.find(
                (o) => o.attributeName() === name
            );
            const envHint =
                option?.envVar !== undefined
                    ? ` (or set ${option.envVar})`
                    : "";
            throw new Error(
                `required option '${option?.flags ?? name}' not specified${envHint}`
            );
        }
        return value;
    };

    const requiredLocalPath = requireOption(localPath, "localPath");
    const requiredRemoteUri = requireOption(remoteUri, "remoteUri");
    const requiredToken = requireOption(token, "token");
    const requiredVaultName = requireOption(vaultName, "vaultName");

    // Validate remote URI protocol
    if (
        !VALID_PROTOCOLS.some((prefix) => requiredRemoteUri.startsWith(prefix))
    ) {
        throw new Error(
            `Invalid remote URI '${requiredRemoteUri}'. Must start with ${VALID_PROTOCOLS.join(", ")}`
        );
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

    const validLineEndings: readonly string[] = ["auto", "lf", "crlf"];
    const isLineEndingMode = (value: string): value is LineEndingMode => {
        return validLineEndings.includes(value);
    };
    if (!isLineEndingMode(lineEndingsStr)) {
        throw new Error(
            `Invalid line endings mode '${lineEndingsStr}'. Valid values are: ${validLineEndings.join(", ")}`
        );
    }
    const lineEndings = lineEndingsStr;

    return {
        localPath: requiredLocalPath,
        remoteUri: requiredRemoteUri,
        token: requiredToken,
        vaultName: requiredVaultName,
        maxFileSizeMB: maxFileSizeMb,
        ignorePatterns: ignorePattern,
        webSocketRetryIntervalMs: websocketRetryIntervalMs,
        logLevel,
        health,
        enableTelemetry,
        quiet,
        lineEndings
    };
}
