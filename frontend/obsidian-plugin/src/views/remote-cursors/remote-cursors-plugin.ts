import { RangeSet, Range } from "@codemirror/state";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	WidgetType
} from "@codemirror/view";

import type { PluginValue, DecorationSet } from "@codemirror/view";
import { RemoteCursorWidget } from "./remote-cursor-widget";

export class RemoteCursorsPluginValue implements PluginValue {
	public decorations: DecorationSet = RangeSet.of([]);

	public constructor(private readonly _editor: EditorView) {}

	public update(update: ViewUpdate) {
		const decorations: Array<Range<Decoration>> = [];

		const cursors: {
			name: string;
			color: string;
			anchor: { index: number };
			head: { index: number };
		}[] = [
			{
				name: "Alice",
				color: "#ff6b6b",
				anchor: { index: 10 },
				head: { index: 20 }
			}
		];

		cursors.forEach(({ name, color, anchor, head }) => {
			const start = Math.min(anchor.index, head.index);
			const end = Math.max(anchor.index, head.index);
			const startLine = update.view.state.doc.lineAt(start);
			const endLine = update.view.state.doc.lineAt(end);

			if (startLine.number === endLine.number) {
				// selected content in a single line.
				decorations.push({
					from: start,
					to: end,
					value: Decoration.mark({
						attributes: {
							style: `background-color: ${color}`
						},
						class: "Selection"
					})
				});
			} else {
				// selected content in multiple lines
				// first, render text-selection in the first line
				decorations.push({
					from: start,
					to: startLine.from + startLine.length,
					value: Decoration.mark({
						attributes: {
							style: `background-color: ${color}`
						},
						class: "Selection"
					})
				});
				// render text-selection in the last line
				decorations.push({
					from: endLine.from,
					to: end,
					value: Decoration.mark({
						attributes: {
							style: `background-color: ${color}`
						},
						class: "Selection"
					})
				});
				for (let i = startLine.number + 1; i < endLine.number; i++) {
					const linePos = update.view.state.doc.line(i).from;
					decorations.push({
						from: linePos,
						to: linePos,
						value: Decoration.line({
							attributes: {
								style: `background-color: ${color}`,
								class: "LineSelection"
							}
						})
					});
				}
			}
			decorations.push({
				from: head.index,
				to: head.index,
				value: Decoration.widget({
					side: head.index - anchor.index > 0 ? -1 : 1, // the local cursor should be rendered outside the remote selection
					block: false,
					widget: new RemoteCursorWidget(color, name)
				})
			});
		});
		this.decorations = Decoration.set(decorations, true);
	}
}

export const remoteCursorsPlugin = ViewPlugin.fromClass(
	RemoteCursorsPluginValue,
	{
		decorations: (v) => v.decorations
	}
);
