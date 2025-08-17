import type { Range } from "@codemirror/state";
import { RangeSet } from "@codemirror/state";
import { ViewPlugin, Decoration } from "@codemirror/view";

import type {
	PluginValue,
	DecorationSet,
	EditorView,
	ViewUpdate
} from "@codemirror/view";
import { RemoteCursorWidget } from "./remote-cursor-widget";
import type {
	CursorSpan,
	DocumentWithMaybeOutdatedClientCursors
} from "sync-client";
import type { App } from "obsidian";
import { MarkdownView } from "obsidian";

let cursors: {
	name: string;
	path: string;
	span: CursorSpan;
	deviceId: string;
}[] = [];

import { StateEffect } from "@codemirror/state";
import { getRandomColor } from "src/utils/get-random-color";
import { updateSelection } from "./update-selection";

const forceUpdate = StateEffect.define();

export class RemoteCursorsPluginValue implements PluginValue {
	public decorations: DecorationSet = RangeSet.of([]);

	public update(update: ViewUpdate): void {
		update.changes.iterChanges((fromA, toA, fromB, toB, _inserted) => {
			const spans = cursors.map((cursor) => cursor.span);
			updateSelection({
				fromA,
				toA,
				fromB,
				toB,
				spans
			});
		});

		const decorations: Range<Decoration>[] = [];

		cursors.forEach(({ name, span: { start, end } }) => {
			const color = getRandomColor(name);
			const startLine = update.view.state.doc.lineAt(start);
			const endLine = update.view.state.doc.lineAt(end);

			const attributes = {
				style: `background-color: ${color};`
			};

			if (startLine.number === endLine.number) {
				// selected content in a single line.
				decorations.push({
					from: start,
					to: end,
					value: Decoration.mark({
						attributes
					})
				});
			} else {
				// selected content in multiple lines
				// first, render text-selection in the first line
				decorations.push({
					from: start,
					to: startLine.from + startLine.length,
					value: Decoration.mark({
						attributes
					})
				});

				// render text-selection in the lines between the first and last line
				for (let i = startLine.number + 1; i < endLine.number; i++) {
					const currentLine = update.view.state.doc.line(i);
					decorations.push({
						from: currentLine.from,
						to: currentLine.to,
						value: Decoration.mark({
							attributes
						})
					});
				}

				// render text-selection in the last line
				decorations.push({
					from: endLine.from,
					to: end,
					value: Decoration.mark({
						attributes
					})
				});
			}

			decorations.push({
				from: end,
				to: end,
				value: Decoration.widget({
					side: end - start > 0 ? -1 : 1, // the local cursor should be rendered outside the remote selection
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

export function setCursors(
	clients: DocumentWithMaybeOutdatedClientCursors[],
	app: App
): void {
	cursors = [
		...cursors.filter(({ deviceId }) =>
			clients.some(
				(client) => client.deviceId === deviceId && client.isOutdated
			)
		),
		...clients
			.filter(({ isOutdated }) => !isOutdated)
			.flatMap((client) => {
				const clientCursors = client.documentsWithCursors;
				return clientCursors.flatMap((cursor) =>
					cursor.cursors.map((span) => ({
						name: client.userName,
						path: cursor.relative_path,
						deviceId: client.deviceId,
						span
					}))
				);
			})
	];

	app.workspace
		.getLeavesOfType("markdown")
		.map((leaf) => leaf.view)
		.filter((view) => view instanceof MarkdownView)
		.forEach((view) => {
			// @ts-expect-error, not typed
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const editor = view.editor.cm as EditorView;

			editor.dispatch({
				effects: [forceUpdate.of(null)]
			});
		});
}
