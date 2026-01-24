export class TimeoutError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "TimeoutError";
    }
}

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
                    new TimeoutError(
                        `${operationName} timed out after ${timeoutMs}ms`
                    )
                );
            }, timeoutMs)
        )
    ]);
}
