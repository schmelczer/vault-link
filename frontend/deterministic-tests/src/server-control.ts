import { spawn, type ChildProcess } from "node:child_process";
import { sleep } from "./utils/sleep";

export class ServerControl {
    private process: ChildProcess | null = null;
    private readonly serverPath: string;
    private readonly configPath: string;

    public constructor(serverPath: string, configPath: string) {
        this.serverPath = serverPath;
        this.configPath = configPath;
    }

    public async start(): Promise<void> {
        if (this.process !== null) {
            throw new Error("Server is already running");
        }

        console.log(`Starting server: ${this.serverPath} ${this.configPath}`);

        let startupError: string | null = null;

        this.process = spawn(this.serverPath, [this.configPath], {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false
        });

        this.process.stdout?.on("data", (data: Buffer) => {
            console.log(`[SERVER] ${data.toString().trim()}`);
        });

        this.process.stderr?.on("data", (data: Buffer) => {
            const msg = data.toString().trim();
            console.error(`[SERVER ERROR] ${msg}`);
            // Capture startup errors
            if (msg.includes("Failed to") || msg.includes("Error")) {
                startupError = msg;
            }
        });

        this.process.on("error", (err) => {
            console.error("[SERVER] Process error:", err);
            startupError = err.message;
        });

        this.process.on("exit", (code, signal) => {
            console.log(`[SERVER] Exited with code ${code}, signal ${signal}`);
            this.process = null;
        });

        // Give the process a moment to fail if it's going to
        await sleep(100);

        // Check if process died during startup (exit handler sets this.process to null)
        this.checkProcessAlive(startupError, "startup");

        // Wait for server to be ready
        await this.waitForReady();

        // Final check that our process is still the one running
        this.checkProcessAlive(startupError, "after startup");
    }

    public async waitForReady(maxAttempts = 30): Promise<void> {
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const response = await fetch(
                    "http://localhost:3000/vaults/test/ping"
                );
                if (response.ok) {
                    console.log("[SERVER] Ready");
                    return;
                }
            } catch {
                // Server not ready yet
            }
            await sleep(100);
        }
        throw new Error("Server failed to start within timeout");
    }

    public pause(): void {
        if (this.process?.pid === undefined) {
            throw new Error("Server is not running");
        }
        console.log("[SERVER] Pausing...");
        process.kill(this.process.pid, "SIGSTOP");
    }

    public resume(): void {
        if (this.process?.pid === undefined) {
            throw new Error("Server is not running");
        }
        console.log("[SERVER] Resuming...");
        process.kill(this.process.pid, "SIGCONT");
    }

    public async stop(): Promise<void> {
        if (this.process?.pid === undefined) {
            return;
        }

        console.log("[SERVER] Stopping...");
        const { pid } = this.process;

        return new Promise((resolve) => {
            if (this.process === null) {
                resolve();
                return;
            }

            this.process.on("exit", () => {
                resolve();
            });

            // Try graceful shutdown first
            process.kill(pid, "SIGTERM");

            // Force kill after 5 seconds
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
