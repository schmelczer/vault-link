import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import type { NetworkConnectionStatus } from "sync-client";
import {
    SyncClient,
    DEFAULT_SETTINGS,
    Logger,
    LogLevel,
    type LogLine,
    type SyncSettings,
    type StoredDatabase
} from "sync-client";
import { parseArgs } from "./args";
import { NodeFileSystemOperations } from "./node-filesystem";
import { FileWatcher } from "./file-watcher";
import { formatLogLine } from "./logger-formatter";
import packageJson from "../package.json";

function writeHealthStatus(
    logger: Logger,
    filePath: string,
    connectionStatus: NetworkConnectionStatus
): void {
    try {
        fsSync.writeFileSync(filePath, JSON.stringify(connectionStatus));
    } catch (error) {
        logger.error(
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

function createLogHandler(minLevel: LogLevel): (logLine: LogLine) => void {
    return (logLine: LogLine): void => {
        if (LOG_LEVEL_ORDER[logLine.level] >= LOG_LEVEL_ORDER[minLevel]) {
            // eslint-disable-next-line no-console
            console.log(formatLogLine(logLine));
        }
    };
}

const HEALTH_CHECK_INTERVAL_MS = 30 * 1000;
const PROGRESS_LOG_INTERVAL_MS = 2000;

function resolveLineEndings(
    mode: "auto" | "lf" | "crlf"
): string {
    switch (mode) {
        case "lf":
            return "\n";
        case "crlf":
            return "\r\n";
        case "auto":
            return process.platform === "win32" ? "\r\n" : "\n";
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv);
    const absolutePath = path.resolve(args.localPath);

    const logger = new Logger();
    const logHandler = createLogHandler(args.logLevel);
    logger.onLogEmitted.add(logHandler);

    if (!fsSync.existsSync(absolutePath)) {
        fsSync.mkdirSync(absolutePath, { recursive: true });
    }

    try {
        const stats = await fs.stat(absolutePath);
        if (!stats.isDirectory()) {
            logger.error(`${absolutePath} is not a directory`);
            process.exit(1);
        }
    } catch (error) {
        logger.error(
            `Cannot access directory ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`
        );
        process.exit(1);
    }

    if (!args.quiet) {
        logger.info(`VaultLink Local CLI v${packageJson.version}`);
        logger.info(`Local path: ${absolutePath}`);
        logger.info(`Remote URI: ${args.remoteUri}`);
        logger.info(`Vault name: ${args.vaultName}`);
        if (args.lineEndings !== "auto") {
            logger.info(
                `Line endings: ${args.lineEndings.toUpperCase()}`
            );
        }
    }

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
                    logger.warn(
                        `Cannot read data file at ${dataFile}`
                    );
                }

                return {
                    settings,
                    database
                };
            },
            save: async ({ database: persistedDatabase }) => {
                await fs.writeFile(
                    dataFile,
                    JSON.stringify(persistedDatabase, null, 2)
                );
            }
        },
        nativeLineEndings: resolveLineEndings(args.lineEndings)
    });

    if (args.health !== undefined) {
        const healthFile = args.health;
        const writeHealth = (): void => {
            void client.checkConnection().then((status) => {
                writeHealthStatus(client.logger, healthFile, status);
            });
        };
        writeHealth();
        const healthInterval = setInterval(
            writeHealth,
            HEALTH_CHECK_INTERVAL_MS
        );
        const clearHealthInterval = (): void => {
            clearInterval(healthInterval);
        };
        process.on("SIGINT", clearHealthInterval);
        process.on("SIGTERM", clearHealthInterval);
        process.on("exit", clearHealthInterval);
    }

    client.logger.onLogEmitted.add(logHandler);
    client.logger.info("Starting sync client");

    const fileWatcher = new FileWatcher(absolutePath, client, ignorePatterns);

    client.onWebSocketStatusChanged.add(() => {
        const isConnected = client.isWebSocketConnected;
        client.logger.info(
            `WebSocket status changed: ${isConnected ? "connected" : "disconnected"}`
        );
    });

    let syncBatchSize = 0;
    let totalSyncOps = 0;
    let lastProgressLogTime = 0;

    client.onRemainingOperationsCountChanged.add((remaining) => {
        if (remaining > syncBatchSize) {
            syncBatchSize = remaining;
        }

        if (remaining === 0) {
            if (syncBatchSize > 0) {
                totalSyncOps += syncBatchSize;
                client.logger.info(
                    `Sync batch complete (${syncBatchSize} operations)`
                );
                syncBatchSize = 0;
            }
        } else {
            const now = Date.now();
            if (now - lastProgressLogTime >= PROGRESS_LOG_INTERVAL_MS) {
                client.logger.info(
                    `Syncing: ${remaining} operations remaining`
                );
                lastProgressLogTime = now;
            }
        }
    });

    let isShuttingDown = false;
    const gracefulShutdown = async (signal: string): Promise<void> => {
        if (isShuttingDown) {
            return;
        }
        isShuttingDown = true;

        client.logger.info(
            `${signal} received, shutting down gracefully`
        );

        fileWatcher.stop();
        await client.waitUntilFinished();
        await client.destroy();

        if (totalSyncOps > 0) {
            client.logger.info(
                `Shutdown complete (${totalSyncOps} operations synced)`
            );
        } else {
            client.logger.info("Shutdown complete");
        }
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
            client.logger.error(
                `Cannot connect to server: ${connectionStatus.serverMessage}`
            );
            process.exit(1);
        }

        if (!args.quiet) {
            client.logger.info("Server connection successful");
        }

        await client.start();
        fileWatcher.start();
    } catch (error) {
        client.logger.error(
            `Fatal error: ${error instanceof Error ? error.message : String(error)}`
        );

        fileWatcher.stop();
        await client.destroy();
        process.exit(1);
    }
}

main().catch((error: unknown) => {
    // Last-resort handler before the logger exists
    // eslint-disable-next-line no-console
    console.error(
        `Unexpected error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
});
