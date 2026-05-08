export async function runWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<R>
): Promise<R[]> {
    const results: R[] = [];
    const errors: unknown[] = [];
    const executing = new Set<Promise<void>>();

    for (let i = 0; i < items.length; i++) {
        const index = i;
        const p = fn(items[index])
            .then((result) => {
                results[index] = result;
            })
            .catch((error: unknown) => {
                errors.push(error);
            })
            .finally(() => executing.delete(p));
        executing.add(p);
        if (executing.size >= concurrency) {
            await Promise.race(executing);
        }
    }

    // eslint-disable-next-line no-restricted-properties
    await Promise.all(executing);

    if (errors.length > 0) {
        throw errors[0];
    }
    return results;
}
