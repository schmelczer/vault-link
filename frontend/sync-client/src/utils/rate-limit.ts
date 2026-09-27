import { sleep } from "./sleep";

/** Coalesce calls during each interval; the first waiter runs the latest arguments. */
export function rateLimit<Args extends unknown[], R>(
    fn: (...args: Args) => Promise<R>,
    minIntervalMs: number | (() => number)
): (...args: Args) => Promise<R | undefined> {
    let pending: Args | undefined = undefined;
    let cooldown: Promise<void> | undefined = undefined;

    return async (...args: Args): Promise<R | undefined> => {
        if (cooldown) {
            pending = args;
            await cooldown;

            // Another waiter may already have consumed the latest arguments.
            // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Other calls mutate pending while awaiting the cooldown.
            if (pending === undefined) {
                return;
            }

            args = pending;
            pending = undefined;
        }

        cooldown = sleep(
            typeof minIntervalMs === "function"
                ? minIntervalMs()
                : minIntervalMs
        );
        return fn(...args);
    };
}
