type ResolveFunction<T> = undefined extends T
	? (value?: T) => unknown
	: (value: T) => unknown;

/**
 * A type-safe utility function to create a Promise with resolve and reject functions.
 * @returns A tuple containing a Promise, a resolve function, and a reject function.
 */
export function createPromise<T = unknown>(): [
	Promise<T>,
	ResolveFunction<T>,
	(error: unknown) => unknown
] {
	let resolve: undefined | ResolveFunction<T> = undefined;
	let reject: undefined | ((error: unknown) => unknown) = undefined;

	const creationPromise = new Promise<T>(
		(resolve_, reject_) =>
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			((resolve = resolve_ as ResolveFunction<T>), (reject = reject_))
	);

	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	return [creationPromise, resolve!, reject!];
}
