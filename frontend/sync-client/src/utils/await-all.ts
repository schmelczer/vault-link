type PromiseTuple<T extends readonly unknown[]> = readonly [
	...{ [K in keyof T]: Promise<T[K]> }
];

type ResolvedTuple<T extends readonly unknown[]> = {
	[K in keyof T]: T[K];
};

export const awaitAll = async <T extends readonly unknown[]>(
	promises: PromiseTuple<T>
): Promise<ResolvedTuple<T>> => {
	const result = await Promise.allSettled(promises);
	for (const res of result) {
		if (res.status === "rejected") {
			throw res.reason;
		}
	}

	return result.map(
		(res) => (res as PromiseFulfilledResult<unknown>).value
	) as ResolvedTuple<T>;
};
