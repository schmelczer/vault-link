/** Serializes operations in arrival order; failures do not block the queue. */
export class Lock {
    private tail: Promise<unknown> = Promise.resolve();

    // eslint-disable-next-line @typescript-eslint/promise-function-async -- Preserve the queued operation promise without an extra async wrapper.
    public withLock<R>(fn: () => R | Promise<R>): Promise<R> {
        const operation = this.tail.then(fn);
        this.tail = operation.catch(() => undefined);
        return operation;
    }
}
