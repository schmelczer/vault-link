import * as os from "node:os";

export function parseConcurrency(): number {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
        if (
            (args[i] === "--concurrency" || args[i] === "-j") &&
            i + 1 < args.length
        ) {
            const n = parseInt(args[i + 1], 10);
            if (!isNaN(n) && n > 0) {
                return n;
            }
        }
    }
    return os.cpus().length;
}
