export async function abortable<T>(
    signal: AbortSignal,
    operation: () => Promise<T>
): Promise<T> {
    signal.throwIfAborted();

    let abort = (): void => undefined;

    try {
        return await Promise.race([
            new Promise<never>((_, reject) => {
                abort = (): void => {
                    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Only reset errors and timeout errors reach this helper.
                    reject(signal.reason);
                };

                signal.addEventListener("abort", abort, { once: true });
            }),
            operation()
        ]);
    } finally {
        signal.removeEventListener("abort", abort);
    }
}
