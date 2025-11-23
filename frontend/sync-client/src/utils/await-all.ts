type PromiseTuple<T extends readonly unknown[]> = readonly [
	...{ [K in keyof T]: Promise<T[K]> }
];

type ResolvedTuple<T extends readonly unknown[]> = {
	[K in keyof T]: T[K];
};

export const awaitAll = async <T extends readonly unknown[]>(
	promises: PromiseTuple<T>
): Promise<ResolvedTuple<T>> => {
	// eslint-disable-next-line no-restricted-properties
	const result = await Promise.allSettled(promises);
	for (const res of result) {
		if (res.status === "rejected") {
			throw res.reason;
		}
	}

	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return result.map(
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		(res) => (res as PromiseFulfilledResult<unknown>).value
	) as ResolvedTuple<T>;
};
