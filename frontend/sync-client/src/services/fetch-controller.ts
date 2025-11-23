import type { Logger } from "../tracing/logger";
import { createPromise } from "../utils/create-promise";
import { SyncResetError } from "./sync-reset-error";

/**
 * Offers a resettable fetch implementation that waits until syncing is enabled
 * and aborts outstanding requests when a reset is started.
 */
export class FetchController {
	private static readonly UNTIL_RESOLUTION = Symbol();

	private isResetting = false;

	// Promise resolves on the next state change: sync enabled/disabled or reset started/ended
	private until: Promise<symbol>;
	private resolveUntil: (result: symbol) => unknown;
	private rejectUntil: (reason: unknown) => unknown;

	public constructor(
		private _canFetch: boolean,
		private readonly logger: Logger
	) {
		[this.until, this.resolveUntil, this.rejectUntil] =
			createPromise<symbol>();
	}

	/**
	 * Whether the fetch implementation can immediately send requests once outside of a reset.
	 */
	public get canFetch(): boolean {
		return this._canFetch;
	}

	/**
	 * Allow or disallow fetching. The changes only take effect if not resetting.
	 * When called during a reset, its effect is deferred until the reset is finished.
	 *
	 * @param canFetch Whether fetching is enabled
	 */
	public set canFetch(canFetch: boolean) {
		this._canFetch = canFetch;

		if (!this.isResetting) {
			const previousResolve = this.resolveUntil;
			[this.until, this.resolveUntil, this.rejectUntil] =
				createPromise<symbol>();
			previousResolve(FetchController.UNTIL_RESOLUTION);
		}
	}

	private static getUrlFromInput(input: RequestInfo | URL): string {
		if (input instanceof URL) {
			return input.href;
		}
		if (typeof input === "string") {
			return input;
		}
		return input.url;
	}

	/**
	 * Starts a reset, causing all ongoing and future fetches to be rejected
	 * with a SyncResetError until finishReset is called.
	 */
	public startReset(): void {
		this.isResetting = true;
		this.rejectUntil(new SyncResetError());
		// Catch unhandled rejection if no fetches are waiting
		this.until.catch(() => {
			// Intentionally ignore - this rejection is handled by waiting fetches
		});
	}

	/**
	 * Finishes a reset, allowing fetches to proceed or wait again depending on
	 * the current sync settings.
	 */
	public finishReset(): void {
		if (!this.isResetting) {
			return;
		}

		this.isResetting = false;
		[this.until, this.resolveUntil, this.rejectUntil] = createPromise();
	}

	/**
	 *
	 * |------------------|---------------|-----------------------------------------------------|
	 * |                  | Sync enabled  |                 Sync disabled                       |
	 * |------------------|-------------- |-----------------------------------------------------|
	 * | During reset     |        Rejects with SyncResetError without sending request          |
	 * |------------------|-------------- |-----------------------------------------------------|
	 * | Outside of reset | Same as fetch | Blocks until sync is enabled and then same as fetch |
	 * |------------------|---------------|-----------------------------------------------------|
	 *
	 * @param logger for errors
	 * @param fetch to wrap
	 * @returns a wrapped fetch implementation affected by the FetchController state
	 */
	public getControlledFetchImplementation(
		logger: Logger,
		fetch: typeof globalThis.fetch = globalThis.fetch
	): typeof globalThis.fetch {
		return async (
			input: RequestInfo | URL,
			init?: RequestInit
		): Promise<Response> => {
			while (!this.canFetch || this.isResetting) {
				await this.until;
			}

			try {
				// https://github.com/jonbern/fetch-retry/blob/8684ef4e688375f623bd76f13add76dbc1d67cfb/index.js#L67C1-L70C21
				const _input =
					typeof Request !== "undefined" && input instanceof Request
						? input.clone()
						: input;

				const fetchPromise = fetch(_input, init);

				// We only want to catch rejections from `this.until`
				let result: symbol | Response | undefined = undefined;
				do {
					result = await Promise.race([this.until, fetchPromise]);
				} while (result === FetchController.UNTIL_RESOLUTION);

				const fetchResult: Response = result as Response; // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion

				if (!fetchResult.ok) {
					this.logger.warn(
						`Fetch for ${FetchController.getUrlFromInput(
							input
						)}, got status ${fetchResult.status}`
					);
				}

				return fetchResult;
			} catch (error) {
				logger.warn(
					`Fetch for ${FetchController.getUrlFromInput(
						input
					)}, got error: ${error}`
				);
				throw error;
			}
		};
	}
}
