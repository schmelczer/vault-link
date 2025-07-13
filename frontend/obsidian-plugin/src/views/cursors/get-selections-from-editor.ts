import type { Editor } from "obsidian";
import { lineAndColumnToPosition } from "../../utils/line-and-column-to-position";

export interface Selection {
	id: number;
	start: number;
	end: number;
}

export function getSelectionsFromEditor(editor: Editor): Selection[] {
	const text = editor.getValue();
	return editor.listSelections().map(({ anchor, head }, i) => ({
		id: i,
		start: lineAndColumnToPosition(text, anchor.line, anchor.ch),
		end: lineAndColumnToPosition(text, head.line, head.ch)
	}));
}
