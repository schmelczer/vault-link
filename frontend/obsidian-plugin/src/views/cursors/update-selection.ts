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
			// the change covers the entirety of the selection
			if (toA > span.end) {
				span.start = toB;
				span.end = toB;
				return;
			}

			let change = toB - toA;
			if (change < 0) {
				// it's a deletion
				// if overlaps with the start, we can't move it back more than the deleted range
				change = Math.max(change, fromA - span.start);
			}

			span.start += change;
			span.end += change;
		} else if (toA <= span.end) {
			span.end += toB - toA;
		} else if (toB <= span.end) {
			// a deletion overlaps with the end, so we move the end
			span.end = toB;
		}
	});
};
