import { parseArgs } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Logger } from "sync-client";
import { ServerControl } from "../../deterministic-tests/src/server-control";
import { ServerManager } from "../../deterministic-tests/src/server-manager";
import { TestRunner } from "../../deterministic-tests/src/test-runner";
import { generateTrace, traceTest, type Trace } from "./workload";

function integer(value: string, zero = false): number {
    const number = Number(value);
    if (
        !/^\d+$/.test(value) ||
        !Number.isSafeInteger(number) ||
        number < (zero ? 0 : 1)
    )
        throw new Error(`Invalid integer: ${value}`);
    return number;
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            seed: { type: "string", default: "1" },
            iterations: { type: "string", default: "25" },
            replay: { type: "string" },
            artifacts: { type: "string" },
            "server-binary": { type: "string" },
            config: { type: "string" }
        }
    });
    const seed = integer(values.seed!, true),
        iterations = integer(values.iterations!);
    const trace: Trace = values.replay
        ? (JSON.parse(fs.readFileSync(values.replay, "utf8")) as Trace)
        : generateTrace(seed, iterations);
    const artifacts = values.artifacts
        ? path.resolve(values.artifacts)
        : fs.mkdtempSync(path.join(os.tmpdir(), "vault-link-fuzz-"));
    fs.mkdirSync(artifacts, { recursive: true });
    const tracePath = path.join(artifacts, `trace-${trace.seed}.json`);
    fs.writeFileSync(tracePath, JSON.stringify(trace, null, 2));
    console.log(`Replay: node ${__filename} --replay ${tracePath}`);
    const logger = new Logger();
    logger.onLogEmitted.add((line) => console.log(line.message));
    const root = path.resolve(__dirname, "../../..");
    const server = new ServerControl(
        values["server-binary"] ??
            path.join(root, "sync-server/target/release/sync_server"),
        values.config ?? path.join(root, "sync-server/config-e2e.yml"),
        logger
    );
    const manager = new ServerManager(logger);
    manager.track(server);
    manager.installSignalHandlers();
    try {
        await server.start();
        const result = await new TestRunner(
            server,
            logger,
            "test-token-change-me",
            server.remoteUri
        ).runTest(`seed-${trace.seed}`, traceTest(trace));
        fs.writeFileSync(
            path.join(artifacts, `result-${trace.seed}.json`),
            JSON.stringify(result, null, 2)
        );
        if (!result.success) throw new Error(result.error);
    } finally {
        await server.stop();
        manager.untrack(server);
    }
}

process.on("unhandledRejection", (error) => {
    console.error(error);
    process.exit(1);
});
process.on("uncaughtException", (error) => {
    console.error(error);
    process.exit(1);
});
main().then(
    () => process.exit(0),
    (error: unknown) => {
        console.error(error);
        process.exit(1);
    }
);
