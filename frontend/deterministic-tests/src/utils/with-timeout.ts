export async function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined = undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error(message));
        }, timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => {
        clearTimeout(timeoutId);
    });
}
