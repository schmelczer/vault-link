import type { CursorSpan } from "sync-client";

export const updateSelection = ({
	fromA,
	toA,
	toB,
	spans
}: {
	fromA: number;
	toA: number;
	fromB: number;
	toB: number;
	spans: CursorSpan[];
}): void => {
	spans.forEach((span) => {
		if (fromA <= span.start) {
			// The change covers the entirety of the selection
			if (toA > span.end) {
				span.start = toB;
				span.end = toB;
				return;
			}

			let change = toB - toA;
			if (change < 0) {
				change = Math.max(change, fromA - span.start);
			}

			span.start += change;
			span.end += change;
		} else if (toA <= span.end) {
			span.end += toB - toA;
		} else if (toB <= span.end) {
			span.end = toB;
		}
	});
};
