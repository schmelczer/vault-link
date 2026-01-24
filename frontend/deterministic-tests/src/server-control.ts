import { spawn, type ChildProcess } from "node:child_process";
import { sleep } from "./utils/sleep";
import type { Logger } from "sync-client";
import { PING_URL } from "./consts";

export class ServerControl {
    private process: ChildProcess | null = null;
    private readonly serverPath: string;
    private readonly configPath: string;
    private readonly logger: Logger;

    public constructor(serverPath: string, configPath: string, logger: Logger) {
        this.serverPath = serverPath;
        this.configPath = configPath;
        this.logger = logger;
    }

    public async start(): Promise<void> {
        if (this.process !== null) {
            throw new Error("Server is already running");
        }

        this.logger.info(
            `Starting server: ${this.serverPath} ${this.configPath}`
        );

        let startupError: string | null = null;

        this.process = spawn(this.serverPath, [this.configPath], {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false
        });

        this.process.stdout?.on("data", (data: Buffer) => {
            this.logger.info(`[SERVER] ${data.toString().trim()}`);
        });

        this.process.stderr?.on("data", (data: Buffer) => {
            const msg = data.toString().trim();
            this.logger.info(`[SERVER] ${msg}`);
            if (msg.includes("Failed to") || msg.includes("Error")) {
                startupError = msg;
            }
        });

        this.process.on("error", (err) => {
            this.logger.error(`[SERVER] Process error: ${err.message}`);
            startupError = err.message;
        });

        this.process.on("exit", (code, signal) => {
            this.logger.info(
                `Server exited with code ${code}, signal ${signal}`
            );
            this.process = null;
        });

        await sleep(100);
        this.checkProcessAlive(startupError, "startup");
        await this.waitForReady();
        this.checkProcessAlive(startupError, "after startup");
    }

    public async waitForReady(maxAttempts = 30): Promise<void> {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const response = await fetch(PING_URL);
                if (response.ok) {
                    this.logger.info("[SERVER] Ready");
                    return;
                }
            } catch {
                // Server not ready yet, continue polling
            }
            await sleep(100);
        }
        throw new Error("Server failed to start within timeout");
    }

    public pause(): void {
        if (this.process?.pid === undefined) {
            throw new Error("Server is not running");
        }
        this.logger.info("Server pausing...");
        process.kill(this.process.pid, "SIGSTOP");
    }

    public resume(): void {
        if (this.process?.pid === undefined) {
            throw new Error("Server is not running");
        }
        this.logger.info("Server resuming...");
        process.kill(this.process.pid, "SIGCONT");
    }

    public async stop(): Promise<void> {
        if (this.process?.pid === undefined) {
            return;
        }

        this.logger.info("Server stopping...");
        const { pid } = this.process;

        return new Promise((resolve) => {
            if (this.process === null) {
                resolve();
                return;
            }

            this.process.on("exit", () => {
                resolve();
            });

            process.kill(pid, "SIGTERM");

            setTimeout(() => {
                if (this.process?.pid !== undefined) {
                    process.kill(this.process.pid, "SIGKILL");
                }
            }, 5000);
        });
    }

    public isRunning(): boolean {
        return this.process?.pid !== undefined;
    }

    private checkProcessAlive(
        startupError: string | null,
        phase: string
    ): void {
        const proc = this.process;
        if (proc === null) {
            throw new Error(
                `Server process died during ${phase}: ${startupError ?? "unknown error"}`
            );
        }
        if (proc.exitCode !== null) {
            throw new Error(
                `Server process exited during ${phase}: ${startupError ?? "unknown error"}`
            );
        }
    }
}
