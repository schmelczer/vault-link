import { Logger } from "sync-client";

export class PrefixedLogger extends Logger {
    private readonly base: Logger;
    private readonly prefix: string;

    public constructor(base: Logger, prefix: string) {
        super();
        this.base = base;
        this.prefix = prefix;
    }

    public override debug(message: string): void {
        this.base.debug(`[${this.prefix}] ${message}`);
    }

    public override info(message: string): void {
        this.base.info(`[${this.prefix}] ${message}`);
    }

    public override warn(message: string): void {
        this.base.warn(`[${this.prefix}] ${message}`);
    }

    public override error(message: string): void {
        this.base.error(`[${this.prefix}] ${message}`);
    }
}
