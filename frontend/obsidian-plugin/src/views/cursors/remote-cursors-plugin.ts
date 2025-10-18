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
import {
	utils,
	type CursorSpan,
	type MaybeOutdatedClientCursors
} from "sync-client";
import type { App } from "obsidian";
import { MarkdownView } from "obsidian";

import { StateEffect } from "@codemirror/state";
import type { SpanWithHistory } from "reconcile-text";
import { reconcileWithHistory } from "reconcile-text";

const forceUpdate = StateEffect.define();

export class RemoteCursorsPluginValue implements PluginValue {
	private static cursors: {
		name: string;
		path: string;
		span: CursorSpan;
		deviceId: string;
		isOutdated: boolean;
	}[] = [];

	public decorations: DecorationSet = RangeSet.of([]);

	public static setCursors(
		clients: MaybeOutdatedClientCursors[],
		app: App
	): void {
		RemoteCursorsPluginValue.cursors = [
			...RemoteCursorsPluginValue.cursors.filter(({ deviceId }) =>
				clients.some(
					(client) =>
						client.deviceId === deviceId && client.isOutdated
				)
			),
			...clients
				.filter(
					({ isOutdated, deviceId }) =>
						!isOutdated ||
						RemoteCursorsPluginValue.cursors.every(
							(c) => deviceId !== c.deviceId
						)
				)
				.flatMap((client) => {
					const clientCursors = client.documentsWithCursors;
					return clientCursors.flatMap((cursor) =>
						cursor.cursors.map((span) => ({
							name: client.userName,
							path: cursor.relative_path,
							deviceId: client.deviceId,
							isOutdated: client.isOutdated,
							span: { ...span }
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

	private static interpolateRemoteCursorPositions(
		original: string,
		edited: string
	): void {
		if (
			original === edited ||
			RemoteCursorsPluginValue.cursors.length === 0
		) {
			return;
		}

		const updatedPositions: number[] = [];
		const reconciled = reconcileWithHistory(
			original,
			{
				text: original,
				cursors: RemoteCursorsPluginValue.cursors.flatMap(
					({ span }, i) => [
						{ id: i * 2, position: span.start },
						{ id: i * 2 + 1, position: span.end }
					]
				)
			},
			edited
		);

		reconciled.cursors.forEach(({ id, position }) => {
			const whereToJump = RemoteCursorsPluginValue.findWhereToMoveCursor(
				position,
				reconciled.history
			);
			if (whereToJump !== null) {
				updatedPositions[id] = whereToJump;
			} else {
				updatedPositions[id] = position;
			}
		});

		RemoteCursorsPluginValue.cursors.forEach(({ span }, i) => {
			span.start = updatedPositions[i * 2];
			span.end = updatedPositions[i * 2 + 1];
		});
	}

	private static findWhereToMoveCursor(
		cursor: number,
		spans: SpanWithHistory[]
	): number | null {
		let position = 0;
		for (const span of spans) {
			// left and origin are the same
			if (position === cursor && span.history === "AddedFromRight") {
				return position + span.text.length;
			}
			position += span.text.length;
			if (position === cursor && span.history === "RemovedFromRight") {
				return position - span.text.length;
			}
		}

		return null;
	}

	public update(update: ViewUpdate): void {
		const original = update.startState.doc.toString();
		const edited = update.state.doc.toString();

		RemoteCursorsPluginValue.interpolateRemoteCursorPositions(
			original,
			edited
		);

		const decorations: Range<Decoration>[] = [];

		RemoteCursorsPluginValue.cursors.forEach(
			({ name, span: { start, end } }) => {
				const color = utils.getRandomColor(name);
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
					for (
						let i = startLine.number + 1;
						i < endLine.number;
						i++
					) {
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
			}
		);

		this.decorations = Decoration.set(decorations, true);
	}
}

export const remoteCursorsPlugin = ViewPlugin.fromClass(
	RemoteCursorsPluginValue,
	{
		decorations: (v) => v.decorations
	}
);
