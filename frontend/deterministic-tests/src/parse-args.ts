import * as os from "node:os";
import { Command, InvalidArgumentError } from "commander";

export interface CliArgs {
    filter: string | undefined;
    concurrency: number;
}

function parsePositiveInt(value: string): number {
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n <= 0) {
        throw new InvalidArgumentError("must be a positive integer");
    }
    return n;
}

export function parseArgs(argv: string[]): CliArgs {
    const program = new Command();

    program
        .name("deterministic-tests")
        .description("Scripted multi-client sync tests against a real server")
        .option(
            "-f, --filter <substring>",
            "Run only tests whose name contains this substring"
        )
        .option(
            "-j, --concurrency <number>",
            "Number of tests to run in parallel",
            parsePositiveInt,
            os.cpus().length
        );

    program.parse(argv);

    /* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
    const opts = program.opts();
    const filter = opts.filter as string | undefined;
    const concurrency = opts.concurrency as number;
    /* eslint-enable @typescript-eslint/no-unsafe-type-assertion */

    return { filter, concurrency };
}
