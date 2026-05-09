import { MAX_LOG_MESSAGE_COUNT } from "../consts";
import { EventListeners } from "../utils/data-structures/event-listeners";

export enum LogLevel {
    DEBUG = "DEBUG",
    INFO = "INFO",
    WARNING = "WARNING",
    ERROR = "ERROR"
}

const LOG_LEVEL_ORDER = {
    [LogLevel.DEBUG]: 0,
    [LogLevel.INFO]: 1,
    [LogLevel.WARNING]: 2,
    [LogLevel.ERROR]: 3
};

export class LogLine {
    public timestamp = new Date();
    public constructor(
        public level: LogLevel,
        public message: string
    ) {}
}

export class Logger {
    public readonly onLogEmitted = new EventListeners<
        (message: LogLine) => unknown
    >();

    private readonly messages: LogLine[] = [];

    public debug(message: string): void {
        this.pushMessage(message, LogLevel.DEBUG);
    }

    public info(message: string): void {
        this.pushMessage(message, LogLevel.INFO);
    }

    public warn(message: string): void {
        this.pushMessage(message, LogLevel.WARNING);
    }

    public error(message: string): void {
        this.pushMessage(message, LogLevel.ERROR);
    }

    public getMessages(mininumSeverity: LogLevel): LogLine[] {
        return this.messages.filter(
            (message) =>
                LOG_LEVEL_ORDER[message.level] >=
                LOG_LEVEL_ORDER[mininumSeverity]
        );
    }

    private pushMessage(message: string, level: LogLevel): void {
        const logLine = new LogLine(level, message);
        this.messages.push(logLine);

        while (this.messages.length > MAX_LOG_MESSAGE_COUNT) {
            this.messages.shift();
        }

        this.onLogEmitted.trigger(logLine);
    }
}
