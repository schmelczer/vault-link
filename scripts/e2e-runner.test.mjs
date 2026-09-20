import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOptions, runCommand } from "./e2e-runner.mjs";

test("the clean-install lockfile includes every workspace and its declared dependencies", () => {
    const frontend = new URL("../frontend/", import.meta.url);
    const readJson = (path) =>
        JSON.parse(readFileSync(new URL(path, frontend), "utf8"));
    const root = readJson("package.json");
    const lock = readJson("package-lock.json");
    assert.deepEqual(lock.packages[""].workspaces, root.workspaces);
    for (const workspace of ["", ...root.workspaces]) {
        const manifest = workspace
            ? readJson(`${workspace}/package.json`)
            : root;
        const locked = lock.packages[workspace];
        assert(locked, `Missing workspace from lockfile: ${workspace}`);
        for (const field of [
            "dependencies",
            "devDependencies",
            "optionalDependencies",
            "peerDependencies",
        ])
            assert.deepEqual(
                locked[field] ?? {},
                manifest[field] ?? {},
                `Stale ${workspace || "root"} ${field}; regenerate the lockfile before CI`,
            );
        if (workspace) {
            assert.equal(locked.version, manifest.version);
            assert.deepEqual(lock.packages[`node_modules/${manifest.name}`], {
                resolved: workspace,
                link: true,
            });
        }
    }
});

test("CI installs dependencies before E2E and uploads the runner's artifacts on failure", () => {
    const workflow = readFileSync(
        new URL("../.forgejo/workflows/e2e.yml", import.meta.url),
        "utf8",
    );
    // Guard the workflow/runner contract without requiring a CI service or
    // installing dependencies just to run the runner's own tests.
    const steps = workflow.split(/^      - /m);
    const install = steps.findIndex((step) => /run: npm ci\s*$/m.test(step));
    const e2e = steps.findIndex((step) =>
        /run: scripts\/e2e\.sh\s*$/m.test(step),
    );
    assert(install > 0 && install < e2e, "npm ci must precede the E2E build");
    assert.match(steps[install], /working-directory: frontend\s*$/m);
    assert.match(workflow, /^  E2E_ARTIFACTS: logs\/e2e\s*$/m);
    assert.match(workflow, /^  E2E_WORKERS: 8\s*$/m);
    const upload = steps.find((step) =>
        step.includes("uses: actions/upload-artifact@"),
    );
    assert(upload, "CI must collect diagnostics");
    assert.match(upload, /if: always\(\)/);
    assert.match(upload, /path: \$\{\{ env\.E2E_ARTIFACTS \}\}/);
    assert.doesNotMatch(
        workflow,
        /cargo run|SERVER_PID|scripts\/clean-up\.sh/,
        "The runner owns server lifecycle and isolated temporary databases",
    );
});

test("e2e rejects zero/fractional/garbage workers and seed overflow", () => {
    for (const value of ["0", "1.5", "2x", "-1", "33"])
        assert.throws(() => parseOptions({ E2E_WORKERS: value }));
    assert.throws(() =>
        parseOptions({ E2E_WORKERS: "2", E2E_SEED: "4294967295" }),
    );
    assert.equal(parseOptions({ E2E_SEED: "0" }).seed, 0);
});

test("e2e observes exit codes, spawn errors, logs and bounded timeout", async () => {
    const directory = mkdtempSync(join(tmpdir(), "vault-link-runner-test-"));
    try {
        const options = {
            cwd: directory,
            logPath: join(directory, "run.log"),
            timeout: 5_000,
        };
        const failed = await runCommand(
            process.execPath,
            ["-e", "console.log('last line'); process.exitCode = 7"],
            options,
        );
        assert.equal(failed.code, 7);
        assert.equal(failed.success, false);
        assert.equal(readFileSync(options.logPath, "utf8").trim(), "last line");
        const missing = await runCommand(
            join(directory, "missing-command"),
            [],
            options,
        );
        assert.equal(missing.success, false);
        assert(missing.error);
        const badLog = await runCommand(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { ...options, logPath: directory },
        );
        assert(!badLog.success);
        assert(badLog.error);
        const timedOut = await runCommand(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { ...options, timeout: 40 },
        );
        assert(timedOut.timedOut);
        assert(!timedOut.success);
        assert(
            (
                await runCommand(
                    process.execPath,
                    ["-e", "process.exit(0)"],
                    options,
                )
            ).success,
        );
    } finally {
        rmSync(directory, { recursive: true });
    }
});

test("E2E includes both peers' unit suites and the permanent audit regressions", () => {
    const runner = readFileSync(
        new URL("./e2e-runner.mjs", import.meta.url),
        "utf8",
    );
    assert.match(
        runner.replace(/\s+/g, ""),
        /run\("server-unit-tests","cargo",\["test"\]/,
    );
    assert.match(
        runner.replace(/\s+/g, ""),
        /run\("client-unit-tests","npm",\["run","test","--workspace","sync-client"\]/,
    );
    const scripts = JSON.parse(
        readFileSync(
            new URL("../frontend/package.json", import.meta.url),
            "utf8",
        ),
    ).scripts;
    for (const file of ["engine-regressions", "sync-audit"])
        assert(
            scripts["test:harness"].includes(`'test-support/${file}.test.ts'`),
            `${file} must be an individually quoted test argument`,
        );
    assert(
        scripts["test:protocol"].includes(
            "'test-support/protocol-audit.test.ts'",
        ),
    );
});
