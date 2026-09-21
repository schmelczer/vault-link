import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sleep } from "./utils/sleep";
import { findFreePort } from "./utils/find-free-port";
import type { Logger } from "sync-client";
import {
    STOP_TIMEOUT_MS,
    SERVER_READY_POLL_INTERVAL_MS,
    SERVER_READY_MAX_ATTEMPTS,
    SERVER_START_MAX_ATTEMPTS
} from "./consts";

export class ServerControl {
    private process: ChildProcess | null = null;
    private readonly serverPath: string;
    private readonly baseConfigPath: string;
    private readonly logger: Logger;
    private _port: number | undefined;
    private tempDir: string | undefined;
    private _isPaused = false;
    private preserveOnStop = false;
    private expectedExit = false;
    private unexpectedExit?: Error;

    public constructor(serverPath: string, configPath: string, logger: Logger) {
        this.serverPath = path.resolve(serverPath);
        this.baseConfigPath = path.resolve(configPath);
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

    public get databaseDirectory(): string {
        if (!this.tempDir) throw new Error("Server has no database directory");
        return path.join(this.tempDir, "databases");
    }

    public get isPaused(): boolean {
        return this._isPaused;
    }

    public async start(): Promise<void> {
        if (this.process !== null) {
            throw new Error("Server is already running");
        }

        // Retry on bind failure: findFreePort closes its probe before we
        // spawn, so under heavy parallelism another process can grab the
        // same port. Each attempt picks a fresh port.
        let lastError: unknown;
        for (let attempt = 1; attempt <= SERVER_START_MAX_ATTEMPTS; attempt++) {
            try {
                await this.startOnce();
                return;
            } catch (error) {
                lastError = error;
                this.logger.warn(
                    `Server start attempt ${attempt}/${SERVER_START_MAX_ATTEMPTS} failed: ${error instanceof Error ? error.message : String(error)}`
                );
                // startOnce already cleaned up its child + tempdir on failure.
            }
        }
        throw new Error(
            `Server failed to start after ${SERVER_START_MAX_ATTEMPTS} attempts: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
            { cause: lastError instanceof Error ? lastError : undefined }
        );
    }

    private async startOnce(): Promise<void> {
        const reservation =
            this._port === undefined ? await findFreePort() : undefined;
        this._port ??= reservation!.port;
        const tmpBase = os.tmpdir();
        let tempConfigPath: string;
        try {
            this.tempDir ??= fs.mkdtempSync(
                path.join(tmpBase, "vault-link-test-")
            );
            tempConfigPath = path.join(this.tempDir, "config.yml");
            this.writeConfigFile(
                tempConfigPath,
                path.join(this.tempDir, "databases")
            );
        } catch (error) {
            reservation?.release();
            this.cleanupTempDir();
            throw error;
        }

        this.logger.info(
            `Starting server: ${this.serverPath} (port ${this._port})`
        );

        // Release the port reservation right before spawning to minimize
        // the TOCTOU window between port discovery and server binding.
        reservation?.release();

        this.process = spawn(this.serverPath, [tempConfigPath], {
            cwd: this.tempDir,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false
        });
        this.expectedExit = false;
        this.unexpectedExit = undefined;

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
            if (!this.expectedExit)
                this.unexpectedExit = new Error(
                    `Owned server exited unexpectedly (code ${code}, signal ${signal})`
                );
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

    public async waitForReady(
        maxAttempts: number = SERVER_READY_MAX_ATTEMPTS
    ): Promise<void> {
        const pingUrl = `${this.remoteUri}/vaults/test/ping`;
        for (let i = 0; i < maxAttempts; i++) {
            if (this.process?.exitCode !== null) {
                throw new Error(
                    "Server process died while waiting for it to become ready"
                );
            }
            try {
                const response = await fetch(pingUrl, {
                    signal: AbortSignal.timeout(1_000)
                });
                if (response.ok) {
                    this.logger.info("[SERVER] Ready");
                    return;
                }
            } catch {
                // Server not ready yet, continue polling
            }
            await sleep(SERVER_READY_POLL_INTERVAL_MS);
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
            if (!this.preserveOnStop) this.cleanupTempDir();
            if (this.unexpectedExit) throw this.unexpectedExit;
            return;
        }
        this.expectedExit = true;

        // SIGKILL terminates even a stopped process; SIGCONT is harmless here.
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
            if (proc.exitCode !== null || proc.signalCode !== null) {
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
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                exitPromise,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    "Owned server did not exit after SIGKILL"
                                )
                            ),
                        STOP_TIMEOUT_MS
                    );
                })
            ]);
        } finally {
            clearTimeout(timer);
        }

        this.process = null;
        this._isPaused = false;
        if (!this.preserveOnStop) this.cleanupTempDir();
        if (this.unexpectedExit) throw this.unexpectedExit;
    }

    /** A real process death: retain the exact database and port for restart. */
    public async crash(): Promise<void> {
        if (!this.isRunning()) throw new Error("Cannot crash a stopped server");
        this.preserveOnStop = true;
        try {
            await this.stop();
        } finally {
            this.preserveOnStop = false;
        }
    }

    public async restart(): Promise<void> {
        if (!this.tempDir || this.isRunning())
            throw new Error(
                "Restart requires a crashed server with retained storage"
            );
        await this.startOnce();
    }

    public isRunning(): boolean {
        const proc = this.process;
        return (
            proc?.pid !== undefined &&
            proc.exitCode === null &&
            proc.signalCode === null
        );
    }

    /**
     * Synchronously SIGCONT-then-SIGKILL the child process. Safe to call
     * from a `process.on("exit", ...)` handler, where async work cannot
     * run. Used as a last-resort cleanup so a SIGSTOP'd server doesn't
     * outlive the test runner and wedge the next CI invocation.
     */
    public forceKillSync(): void {
        const proc = this.process;
        if (proc?.pid === undefined) {
            return;
        }
        try {
            process.kill(proc.pid, "SIGCONT");
        } catch {
            // Process may already be gone or never paused.
        }
        try {
            process.kill(proc.pid, "SIGKILL");
        } catch {
            // Process already gone.
        }
    }

    private writeConfigFile(destPath: string, dbDir: string): void {
        // Assumes config-e2e.yml has exactly one 2-space-indented `port:` and
        // one `databases_directory_path:` (under `server:` and `database:`
        // respectively)
        const baseConfig = fs.readFileSync(this.baseConfigPath, "utf-8");
        for (const key of ["port", "databases_directory_path"]) {
            if (
                (baseConfig.match(new RegExp(`^  ${key}:`, "gm")) ?? [])
                    .length !== 1
            )
                throw new Error(`Expected exactly one config key: ${key}`);
        }
        const config = baseConfig
            .replace(/^\s*port:\s*\d+/m, `  port: ${this._port}`)
            .replace(
                /^\s*databases_directory_path:\s*.+/m,
                `  databases_directory_path: ${JSON.stringify(dbDir)}`
            );
        fs.writeFileSync(destPath, config);
    }

    private cleanupTempDir(): void {
        if (this.tempDir !== undefined) {
            fs.rmSync(this.tempDir, { recursive: true, force: true });
            this.tempDir = undefined;
            this._port = undefined;
        }
    }
}
