import type { SyncClient } from "../../sync-client";
import type { LogLine } from "../../tracing/logger";
import { LogLevel } from "../../tracing/logger";

export function logToConsole(client: SyncClient): void {
    client.logger.onLogEmitted.add((logLine: LogLine) => {
        const formatted = `${logLine.timestamp.toISOString()} ${logLine.level} ${logLine.message}`;

        switch (logLine.level) {
            case LogLevel.ERROR:
                console.error(formatted);
                break;
            case LogLevel.WARNING:
                console.warn(formatted);
                break;
            case LogLevel.INFO:
                console.info(formatted);
                break;
            case LogLevel.DEBUG:
                console.debug(formatted);
                break;
        }
    });
}
