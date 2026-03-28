/* eslint-disable no-console */
import type { Logger, LogLine } from "../../tracing/logger";
import { LogLevel } from "../../tracing/logger";

const COLORS = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    gray: "\x1b[90m"
};

export function logToConsole(
    logger: Logger,
    { useColors = true }: { useColors?: boolean } = {}
): void {
    logger.onLogEmitted.add((logLine: LogLine) => {
        const timestamp = logLine.timestamp.toISOString();
        const {message} = logLine;

        let color = "";
        let reset = "";
        if (useColors) {
            reset = COLORS.reset;
            switch (logLine.level) {
                case LogLevel.ERROR:
                    color = COLORS.red;
                    break;
                case LogLevel.WARNING:
                    color = COLORS.yellow;
                    break;
                case LogLevel.INFO:
                    color = COLORS.blue;
                    break;
                case LogLevel.DEBUG:
                    color = COLORS.gray;
                    break;
            }
        }

        const formatted = `${timestamp} ${color}${logLine.level}${reset} ${message}`;

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
