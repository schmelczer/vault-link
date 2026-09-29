import { randomInt } from "node:crypto";
import { spawn } from "node:child_process";
import {
    createWriteStream,
    mkdirSync,
    mkdtempSync,
    writeFileSync,
    readdirSync,
    readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseOptions(env = process.env) {
    const workers = positive(env.E2E_WORKERS ?? "1", "E2E_WORKERS");

    if (workers > 32) throw new Error("E2E_WORKERS must be at most 32");
    const seedValue =
        env.E2E_SEED ?? String(randomInt(0, 0x100000000 - workers + 1));
    const seed = Number(seedValue);

    if (
        !/^\d+$/.test(seedValue) ||
        !Number.isInteger(seed) ||
        seed < 0 ||
        seed + workers - 1 > 0xffffffff
    ) {
        throw new Error("E2E_SEED range must fit uint32");
    }

    return {
        workers,
        seed,
        iterations: positive(env.E2E_ITERATIONS ?? "25", "E2E_ITERATIONS"),
        timeout:
            positive(env.E2E_TIMEOUT_SECONDS ?? "900", "E2E_TIMEOUT_SECONDS") *
            1000,
    };
}

export async function runCommand(
    command,
    args,
    { cwd, logPath, timeout, active = new Set(), env = process.env },
) {
    const log = createWriteStream(logPath, { flags: "w" });
    const child = spawn(command, args, {
        cwd,
        env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
    });

    let logError;
    log.on("error", (error) => {
        logError = error;
        killOwned(child, "SIGTERM");
    });

    active.add(child);
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    let timedOut = false;
    let hardKill;

    const timer = setTimeout(() => {
        timedOut = true;
        killOwned(child, "SIGTERM");
        hardKill = setTimeout(() => killOwned(child, "SIGKILL"), 5_000);
    }, timeout);

    let spawnError;
    child.once("error", (error) => {
        spawnError = error;
    });

    try {
        const result = await new Promise((resolveResult) =>
            child.once("close", (code, signal) =>
                resolveResult({ code, signal }),
            ),
        );

        if (!logError) {
            await new Promise((resolveLog) => {
                log.once("error", resolveLog);
                log.end(resolveLog);
            });
        }

        return {
            command,
            args,
            ...result,
            timedOut,
            error: spawnError?.message ?? logError?.message,
            success: result.code === 0 && !timedOut && !spawnError && !logError,
        };
    } finally {
        clearTimeout(timer);
        clearTimeout(hardKill);
        active.delete(child);
    }
}

function killOwned(child, signal) {
    if (!child.pid) {
        return;
    }

    try {
        if (process.platform === "win32") {
            child.kill(signal);
        } else {
            process.kill(-child.pid, signal); // the group created by this spawn
        }
    } catch (error) {
        if (error.code !== "ESRCH") {
            throw error;
        }
    }
}

function positive(value, label) {
    const result = Number(value);
    if (
        !/^\d+$/.test(String(value)) ||
        !Number.isSafeInteger(result) ||
        result < 1
    )
        throw new Error(`${label} must be a positive integer`);
    return result;
}

async function main() {
    const options = parseOptions();
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const artifacts = process.env.E2E_ARTIFACTS
        ? resolve(process.env.E2E_ARTIFACTS)
        : mkdtempSync(join(tmpdir(), "vault-link-e2e-"));

    mkdirSync(artifacts, { recursive: true });
    console.log(`Artifacts: ${artifacts}`);
    console.log(
        `Seeds: ${options.seed}..${options.seed + options.workers - 1}; iterations: ${options.iterations}`,
    );

    const active = new Set();
    let interrupted = false;
    const stop = () => {
        interrupted = true;
        for (const child of active) killOwned(child, "SIGTERM");
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.on("exit", () => {
        for (const child of active) killOwned(child, "SIGKILL");
    });

    const results = [];
    const run = async (name, command, args, cwd = root) => {
        if (interrupted) {
            throw new Error("Interrupted");
        }

        const logPath = join(artifacts, `${name}.log`);
        const result = await runCommand(command, args, {
            cwd,
            logPath,
            timeout: options.timeout,
            active,
            env: { ...process.env, E2E_ARTIFACTS: artifacts },
        });
        results.push({ name, ...result });
        writeFileSync(
            join(artifacts, "results.json"),
            JSON.stringify({ options, results }, null, 2),
        );
        console.log(`${result.success ? "PASS" : "FAIL"} ${name}: ${logPath}`);
        return result.success;
    };
    const frontend = join(root, "frontend");

    if (
        !(await run(
            "build-server",
            "cargo",
            ["build", "--release"],
            join(root, "sync-server"),
        ))
    ) {
        throw new Error("Server build failed");
    }

    if (!(await run("build-clients", "npm", ["run", "build"], frontend))) {
        throw new Error(
            "Client build failed (run npm ci in frontend if dependencies are missing)",
        );
    }

    await run(
        "server-unit-tests",
        "cargo",
        ["test"],
        join(root, "sync-server"),
    );
    await run(
        "client-unit-tests",
        "npm",
        ["run", "test", "--workspace", "sync-client"],
        frontend,
    );
    await run(
        "adapter-unit-tests",
        "npm",
        [
            "run",
            "test",
            "--workspace",
            "vault-link-obsidian-plugin",
            "--workspace",
            "local-client-cli",
            "--workspace",
            "test-client",
        ],
        frontend,
    );
    await run("harness-self-tests", "npm", ["run", "test:harness"], frontend);
    await run("crash-and-protocol", "npm", ["run", "test:protocol"], frontend);

    await run("deterministic", process.execPath, [
        join(frontend, "deterministic-tests/dist/cli.js"),
        "--concurrency",
        String(options.workers),
    ]);

    // Concrete regression traces are stable even when the generator evolves.
    const corpus = join(frontend, "test-client/corpus");
    for (const file of readdirSync(corpus)
        .filter((file) => file.endsWith(".json"))
        .sort()) {
        const name = `corpus-${file.replace(/\.json$/, "")}`;
        await run(name, process.execPath, [
            join(frontend, "test-client/dist/cli.js"),
            "--replay",
            join(corpus, file),
            "--artifacts",
            join(artifacts, name),
        ]);
    }

    // Execute all suites even if one reports a regression; failure is never
    // inferred from log text and successful workers cannot mask failed ones.
    await Promise.all(
        Array.from({ length: options.workers }, (_, i) =>
            run(`fuzz-${options.seed + i}`, process.execPath, [
                join(frontend, "test-client/dist/cli.js"),
                "--seed",
                String(options.seed + i),
                "--iterations",
                String(options.iterations),
                "--artifacts",
                join(artifacts, `fuzz-${options.seed + i}`),
            ]),
        ),
    );
    const coverage = {};
    for (const entry of readdirSync(artifacts, { withFileTypes: true }).filter(
        (entry) => entry.isDirectory(),
    )) {
        const directory = join(artifacts, entry.name);
        for (const file of readdirSync(directory).filter((file) =>
            /^result-.*\.json$/.test(file),
        )) {
            const result = JSON.parse(
                readFileSync(join(directory, file), "utf8"),
            );
            for (const [key, count] of Object.entries(result.coverage ?? {}))
                coverage[key] = (coverage[key] ?? 0) + count;
        }
    }
    writeFileSync(
        join(artifacts, "coverage.json"),
        JSON.stringify(coverage, null, 2),
    );
    if (interrupted || results.some((result) => !result.success)) {
        throw new Error(
            `Tests failed; inspect ${join(artifacts, "results.json")}`,
        );
    }

    console.log("All harness suites passed");
}

if (
    process.argv[1] &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
