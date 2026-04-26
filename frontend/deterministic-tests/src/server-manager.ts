import type { ServerControl } from "./server-control";
import type { Logger } from "sync-client";

export class ServerManager {
    private readonly activeServers = new Set<ServerControl>();
    private readonly logger: Logger;
    private isShuttingDown = false;

    public constructor(logger: Logger) {
        this.logger = logger;
    }

    public track(server: ServerControl): void {
        this.activeServers.add(server);
    }

    public untrack(server: ServerControl): void {
        this.activeServers.delete(server);
    }

    public async stopAll(): Promise<void> {
        if (this.isShuttingDown) {return;}
        this.isShuttingDown = true;

        const servers = Array.from(this.activeServers);
        // eslint-disable-next-line no-restricted-properties
        await Promise.all(
            servers.map(async (server) => {
                try {
                    await server.stop();
                } catch {
                    // Best-effort cleanup during shutdown
                }
            })
        );
    }

    public installSignalHandlers(): void {
        process.on("SIGINT", () => {
            this.logger.info("Received SIGINT, shutting down...");
            void this.stopAll()
                .catch(() => {
                    /* no-op */
                })
                .then(() => process.exit(130));
        });

        process.on("SIGTERM", () => {
            this.logger.info("Received SIGTERM, shutting down...");
            void this.stopAll()
                .catch(() => {
                    /* no-op */
                })
                .then(() => process.exit(143));
        });
    }
}
