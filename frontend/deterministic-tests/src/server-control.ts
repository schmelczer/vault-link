import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sleep } from "./utils/sleep";
import { findFreePort } from "./utils/find-free-port";
import type { Logger } from "sync-client";
import { STOP_TIMEOUT_MS } from "./consts";

export class ServerControl {
    private process: ChildProcess | null = null;
    private readonly serverPath: string;
    private readonly baseConfigPath: string;
    private readonly logger: Logger;
    private _port: number | undefined;
    private tempDir: string | undefined;
    private _isPaused = false;

    public constructor(serverPath: string, configPath: string, logger: Logger) {
        this.serverPath = serverPath;
        this.baseConfigPath = configPath;
        this.logger = logger;
    }

    public get port(): number {
        if (this._port === undefined) {
            throw new Error("Server has not been started yet");
        }
        return this._port;
    }

    public get remoteUri(): string {
        return `http://localhost:${this.port}`;
    }

    public async start(): Promise<void> {
        if (this.process !== null) {
            throw new Error("Server is already running");
        }

        const reservation = await findFreePort();
        this._port = reservation.port;
        // Prefer tmpfs (/host/tmp) over disk-backed /tmp for faster SQLite I/O
        const tmpBase = fs.existsSync("/host/tmp") ? "/host/tmp" : os.tmpdir();
        this.tempDir = fs.mkdtempSync(path.join(tmpBase, "vault-link-test-"));
        const tempConfigPath = path.join(this.tempDir, "config.yml");
        const dbDir = path.join(this.tempDir, "databases");

        this.writeConfigFile(tempConfigPath, dbDir);

        this.logger.info(
            `Starting server: ${this.serverPath} (port ${this._port})`
        );

        // Release the port reservation right before spawning to minimize
        // the TOCTOU window between port discovery and server binding.
        reservation.release();

        this.process = spawn(this.serverPath, [tempConfigPath], {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false
        });

        this.process.stdout?.on("data", (data: Buffer) => {
            this.logger.info(`[SERVER] ${data.toString().trim()}`);
        });

        this.process.stderr?.on("data", (data: Buffer) => {
            this.logger.info(`[SERVER] ${data.toString().trim()}`);
        });

        this.process.on("error", (err) => {
            this.logger.error(`[SERVER] Process error: ${err.message}`);
        });

        const currentProcess = this.process;
        currentProcess.on("exit", (code, signal) => {
            this.logger.info(
                `Server exited with code ${code}, signal ${signal}`
            );
            // Only clear state if this handler is for the current process.
            // A fast stop→start cycle could create a new process before this
            // handler fires — clearing state here would corrupt the new one.
            if (this.process === currentProcess) {
                this.process = null;
                this._isPaused = false;
            }
        });

        try {
            await this.waitForReady();
        } catch (error) {
            // Kill the spawned process if it failed to become ready,
            // preventing a zombie process from lingering.
            try {
                await this.stop();
            } catch {
                // Best-effort cleanup
            }
            throw error;
        }
    }

    public async waitForReady(maxAttempts = 50): Promise<void> {
        const pingUrl = `${this.remoteUri}/vaults/test/ping`;
        for (let i = 0; i < maxAttempts; i++) {
            if (this.process?.exitCode !== null) {
                throw new Error(
                    "Server process died while waiting for it to become ready"
                );
            }
            try {
                const response = await fetch(pingUrl);
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
        if (this._isPaused) {
            this.logger.warn("Server is already paused, skipping double-pause");
            return;
        }
        this.logger.info("Server pausing...");
        try {
            process.kill(this.process.pid, "SIGSTOP");
            this._isPaused = true;
            this.logger.info("Server paused (SIGSTOP sent)");
        } catch (error) {
            throw new Error(
                `Failed to pause server (pid ${this.process.pid}): ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    public resume(): void {
        if (this.process?.pid === undefined) {
            throw new Error("Server is not running");
        }
        if (!this._isPaused) {
            return;
        }
        this.logger.info("Server resuming...");
        try {
            process.kill(this.process.pid, "SIGCONT");
            this._isPaused = false;
            this.logger.info("Server resumed (SIGCONT sent)");
        } catch (error) {
            throw new Error(
                `Failed to resume server (pid ${this.process.pid}): ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    public async stop(): Promise<void> {
        const proc = this.process;
        if (proc?.pid === undefined) {
            this.cleanupTempDir();
            return;
        }

        // Resume if paused — a SIGSTOP'd process ignores SIGKILL
        if (this._isPaused) {
            try {
                process.kill(proc.pid, "SIGCONT");
            } catch {
                // Process may already be gone
            }
            this._isPaused = false;
        }

        this.logger.info("Server stopping...");

        // Set up a promise that resolves when the process actually exits.
        const exitPromise = new Promise<void>((resolve) => {
            if (proc.exitCode !== null) {
                resolve();
                return;
            }
            proc.on("exit", () => {
                resolve();
            });
        });

        try {
            process.kill(proc.pid, "SIGKILL");
        } catch {
            // Process already gone
        }

        // Wait for the process to actually exit before cleaning up,
        // with a 5s safety timeout to avoid hanging forever.
        await Promise.race([exitPromise, sleep(STOP_TIMEOUT_MS)]);

        this.process = null;
        this._isPaused = false;
        this.cleanupTempDir();
    }

    public isRunning(): boolean {
        return this.process?.pid !== undefined;
    }

    private writeConfigFile(destPath: string, dbDir: string): void {
        const baseConfig = fs.readFileSync(this.baseConfigPath, "utf-8");
        const config = baseConfig
            .replace(/^\s*port:\s*\d+/m, `  port: ${this._port}`)
            .replace(
                /^\s*databases_directory_path:\s*.+/m,
                `  databases_directory_path: ${dbDir}`
            );
        fs.writeFileSync(destPath, config);
    }

    private cleanupTempDir(): void {
        if (this.tempDir !== undefined) {
            try {
                fs.rmSync(this.tempDir, { recursive: true, force: true });
            } catch {
                // Best-effort cleanup
            }
            this.tempDir = undefined;
        }
    }
}
