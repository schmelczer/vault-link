/* eslint-disable no-console */
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import type { NetworkConnectionStatus } from "sync-client";
import {
    SyncClient,
    DEFAULT_SETTINGS,
    LogLevel,
    type SyncSettings,
    type StoredDatabase
} from "sync-client";
import { parseArgs } from "./args";
import { NodeFileSystemOperations } from "./node-filesystem";
import { FileWatcher } from "./file-watcher";
import { formatLogLine, colorize, styleText } from "./logger-formatter";
import packageJson from "../package.json";

function writeHealthStatus(
    filePath: string,
    connectionStatus: NetworkConnectionStatus
): void {
    try {
        fsSync.writeFileSync(filePath, JSON.stringify(connectionStatus));
    } catch (error) {
        console.error(
            `Failed to write health status to ${filePath}: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

const LOG_LEVEL_ORDER = {
    [LogLevel.DEBUG]: 0,
    [LogLevel.INFO]: 1,
    [LogLevel.WARNING]: 2,
    [LogLevel.ERROR]: 3
};

const HEALTH_CHECK_INTERVAL_MS = 30 * 1000;

async function main(): Promise<void> {
    const args = parseArgs(process.argv);
    const absolutePath = path.resolve(args.localPath);

    if (!fsSync.existsSync(absolutePath)) {
        fsSync.mkdirSync(absolutePath, { recursive: true });
    }

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
        ...DEFAULT_SETTINGS,
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
        isSyncEnabled: true,
        enableTelemetry:
            args.enableTelemetry ?? DEFAULT_SETTINGS.enableTelemetry
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

    if (args.health !== undefined) {
        const healthFile = args.health;
        const healthInterval = setInterval(() => {
            void client.checkConnection().then((status) => {
                writeHealthStatus(healthFile, status);
            });
        }, HEALTH_CHECK_INTERVAL_MS);
        const clearHealthInterval = (): void => {
            clearInterval(healthInterval);
        };
        process.on("SIGINT", clearHealthInterval);
        process.on("SIGTERM", clearHealthInterval);
        process.on("exit", clearHealthInterval);
    }

    // Add colored log formatter with level filtering
    client.logger.onLogEmitted.add((logLine) => {
        // Only show messages at or above the configured log level
        if (LOG_LEVEL_ORDER[logLine.level] >= LOG_LEVEL_ORDER[args.logLevel]) {
            console.log(formatLogLine(logLine));
        }
    });

    client.logger.info("Starting sync client");

    const fileWatcher = new FileWatcher(absolutePath, client);

    client.onWebSocketStatusChanged.add(() => {
        const isConnected = client.isWebSocketConnected;
        client.logger.info(
            `WebSocket status changed: ${isConnected ? "connected" : "disconnected"}`
        );
    });

    client.onRemainingOperationsCountChanged.add((remaining) => {
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
        await client.waitUntilFinished();
        await client.destroy();
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
        console.log(colorize("Press Ctrl+C to stop", "dim"));
        console.log("");

        await client.start();
        fileWatcher.start();
    } catch (error) {
        console.error(
            colorize(
                `Fatal error: ${error instanceof Error ? error.message : String(error)}`,
                "red"
            )
        );

        fileWatcher.stop();
        await client.destroy();
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
