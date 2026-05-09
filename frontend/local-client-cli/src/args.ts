import { Command, Option } from "commander";
import packageJson from "../package.json";
import { LogLevel } from "sync-client";

export const LINE_ENDING_MODES = ["auto", "lf", "crlf"] as const;
export type LineEndingMode = (typeof LINE_ENDING_MODES)[number];

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

const REQUIRED_OPTIONS = {
    localPath: {
        flags: "-l, --local-path <path>",
        env: "VAULTLINK_LOCAL_PATH"
    },
    remoteUri: {
        flags: "-r, --remote-uri <uri>",
        env: "VAULTLINK_REMOTE_URI"
    },
    token: { flags: "-t, --token <token>", env: "VAULTLINK_TOKEN" },
    vaultName: {
        flags: "-v, --vault-name <name>",
        env: "VAULTLINK_VAULT_NAME"
    }
} as const;

function requireOption<T>(
    value: T | undefined,
    name: keyof typeof REQUIRED_OPTIONS
): T {
    if (value === undefined) {
        const { flags, env } = REQUIRED_OPTIONS[name];
        throw new Error(
            `required option '${flags}' not specified (or set ${env})`
        );
    }
    return value;
}

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
                REQUIRED_OPTIONS.localPath.flags,
                "Local directory path to sync"
            ).env(REQUIRED_OPTIONS.localPath.env)
        )
        .addOption(
            new Option(
                REQUIRED_OPTIONS.remoteUri.flags,
                "Remote server URI"
            ).env(REQUIRED_OPTIONS.remoteUri.env)
        )
        .addOption(
            new Option(
                REQUIRED_OPTIONS.token.flags,
                "Authentication token"
            ).env(REQUIRED_OPTIONS.token.env)
        )
        .addOption(
            new Option(REQUIRED_OPTIONS.vaultName.flags, "Vault name").env(
                REQUIRED_OPTIONS.vaultName.env
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
                .choices([...LINE_ENDING_MODES])
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

    const isLineEndingMode = (value: string): value is LineEndingMode =>
        (LINE_ENDING_MODES as readonly string[]).includes(value);
    if (!isLineEndingMode(lineEndingsStr)) {
        throw new Error(
            `Invalid line endings mode '${lineEndingsStr}'. Valid values are: ${LINE_ENDING_MODES.join(", ")}`
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
