import { __debug_locks } from "sync-client";

export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operationName: string
): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => {
                reject(
                    new TimeoutError(`${operationName} timed out after ${timeoutMs}ms ${__debug_locks.map(lock => lock.getDebugString()).join(", ")}`)
                );
            }, timeoutMs)
        )
    ]);
}

export class TimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "TimeoutError";
    }
}