import type { Editor } from "obsidian";
import { utils } from "sync-client";

export interface Selection {
    id: number;
    start: number;
    end: number;
}

export function getSelectionsFromEditor(editor: Editor): Selection[] {
    const text = editor.getValue();
    return editor.listSelections().map(({ anchor, head }, i) => ({
        id: i,
        start: utils.lineAndColumnToPosition(text, anchor.line, anchor.ch),
        end: utils.lineAndColumnToPosition(text, head.line, head.ch)
    }));
}
