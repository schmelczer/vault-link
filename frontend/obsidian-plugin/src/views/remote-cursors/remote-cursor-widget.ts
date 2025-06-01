import { AnnotationType, Annotation, RangeSet, Range } from "@codemirror/state";
import {
	EditorView,
	ViewUpdate,
	ViewPlugin,
	Decoration,
	WidgetType
} from "@codemirror/view";

import type { PluginValue, DecorationSet } from "@codemirror/view";

export class RemoteCursorWidget extends WidgetType {
	public constructor(
		private readonly color: string,
		private readonly name: string
	) {
		super();
	}

	public toDOM(editor: EditorView): HTMLElement {
		return editor.contentDOM.createEl(
			"span",
			{
				cls: "SelectionCaret",
				attr: {
					style: `background-color: ${this.color}; border-color: ${this.color}`
				}
			},
			(span) => {
				span.appendText("\u2060");
				span.createEl("div", {
					cls: "SelectionCaretDot"
				});
				span.appendText("\u2060");
				span.createEl("div", {
					cls: "SelectionInfo",
					text: this.name
				});
				span.appendText("\u2060");
			}
		);
	}

	public eq(other: RemoteCursorWidget) {
		return other.color === this.color && other.name === this.name;
	}
}
