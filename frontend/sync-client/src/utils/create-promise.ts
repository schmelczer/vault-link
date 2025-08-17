/**
 * A type-safe utility function to create a Promise with resolve and reject functions.
 * @returns A tuple containing a Promise, a resolve function, and a reject function.
 */
export function createPromise<T = unknown>(): [
	Promise<T>,
	(value: T) => unknown,
	(error: unknown) => unknown
] {
	let resolve: undefined | ((resolved: T) => unknown) = undefined;
	let reject: undefined | ((error: unknown) => unknown) = undefined;

	const creationPromise = new Promise<T>(
		(resolve_, reject_) => ((resolve = resolve_), (reject = reject_))
	);

	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	return [creationPromise, resolve!, reject!];
}
