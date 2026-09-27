type ResolvedTuple<T extends readonly unknown[]> = {
    -readonly [K in keyof T]: Awaited<T[K]>;
};

/** Await every operation before returning results or throwing the first error. */
export async function awaitAll<T extends readonly unknown[] | []>(
    promises: T
): Promise<ResolvedTuple<T>> {
    // eslint-disable-next-line no-restricted-properties
    const result = await Promise.allSettled(promises);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Array.map preserves tuple order and length.
    return result.map((res) => {
        if (res.status === "rejected") {
            throw res.reason;
        }

        return res.value;
    }) as ResolvedTuple<T>;
}
