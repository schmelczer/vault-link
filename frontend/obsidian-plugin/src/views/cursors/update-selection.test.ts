import { updateSelection } from "./update-selection";

describe("Selection update", () => {
	it("should handle span fully before - insert", () => {
		const spans = [{ start: 3, end: 5 }];
		updateSelection({
			fromA: 0,
			toA: 0,
			fromB: 0,
			toB: 2,
			spans
		});
		expect(spans).toEqual([{ start: 5, end: 7 }]);
	});

	it("should handle span fully before - delete", () => {
		const spans = [{ start: 3, end: 5 }];
		updateSelection({
			fromA: 0,
			toA: 2,
			fromB: 0,
			toB: 0,
			spans
		});
		expect(spans).toEqual([{ start: 1, end: 3 }]);
	});

	it("should handle span fully after - insert", () => {
		const spans = [{ start: 3, end: 5 }];
		updateSelection({
			fromA: 6,
			toA: 6,
			fromB: 6,
			toB: 10,
			spans
		});
		expect(spans).toEqual([{ start: 3, end: 5 }]);
	});

	it("should handle span fully after - delete", () => {
		const spans = [{ start: 3, end: 5 }];
		updateSelection({
			fromA: 6,
			toA: 10,
			fromB: 6,
			toB: 6,
			spans
		});
		expect(spans).toEqual([{ start: 3, end: 5 }]);
	});

	it("should handle span fully within - insert", () => {
		const spans = [{ start: 3, end: 5 }];
		updateSelection({
			fromA: 4,
			toA: 4,
			fromB: 4,
			toB: 6,
			spans
		});
		expect(spans).toEqual([{ start: 3, end: 7 }]);
	});

	it("should handle span fully within - delete", () => {
		const spans = [{ start: 3, end: 5 }];
		updateSelection({
			fromA: 4,
			toA: 5,
			fromB: 4,
			toB: 4,
			spans
		});
		expect(spans).toEqual([{ start: 3, end: 4 }]);
	});

	it("should handle span overlapping with start", () => {
		const spans = [{ start: 3, end: 5 }];
		updateSelection({
			fromA: 2,
			toA: 4,
			fromB: 2,
			toB: 2,
			spans
		});
		expect(spans).toEqual([{ start: 2, end: 4 }]);
	});

	it("should handle span overlapping with end", () => {
		const spans = [{ start: 3, end: 5 }];
		updateSelection({
			fromA: 4,
			toA: 6,
			fromB: 4,
			toB: 4,
			spans
		});
		expect(spans).toEqual([{ start: 3, end: 4 }]);
	});

	it("delete entire selection", () => {
		const spans = [{ start: 3, end: 5 }];
		updateSelection({
			fromA: 0,
			toA: 10,
			fromB: 0,
			toB: 0,
			spans
		});
		expect(spans).toEqual([{ start: 0, end: 0 }]);
	});
});
