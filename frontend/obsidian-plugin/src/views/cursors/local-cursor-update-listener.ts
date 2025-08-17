import type { Workspace } from "obsidian";
import { MarkdownView } from "obsidian";
import type { SyncClient } from "sync-client";
import type { Selection } from "./get-selections-from-editor";
import { getSelectionsFromEditor } from "./get-selections-from-editor";

export class LocalCursorUpdateListener {
	private static readonly UPDATE_INTERVAL_MS = 50;
	private readonly eventHandle: NodeJS.Timeout;

	public constructor(
		private readonly client: SyncClient,
		private readonly workspace: Workspace
	) {
		this.eventHandle = setInterval(() => {
			this.updateAllSelections();
		}, LocalCursorUpdateListener.UPDATE_INTERVAL_MS);
	}

	public dispose(): void {
		clearInterval(this.eventHandle);
	}

	private updateAllSelections(): void {
		const currentCursors = this.getAllSelections();
		this.client
			.updateLocalCursors(currentCursors)
			.catch((error: unknown) => {
				this.client.logger.error(
					`Failed to update local cursors: ${error}`
				);
			});
	}

	private getAllSelections(): Record<string, Selection[]> {
		const cursors: Record<string, Selection[]> = {};
		this.workspace
			.getLeavesOfType("markdown")
			.map((leaf) => leaf.view)
			.filter((view) => view instanceof MarkdownView)
			.forEach((view) => {
				const { file } = view;
				if (!file) {
					return;
				}
				cursors[file.path] = getSelectionsFromEditor(view.editor);
			});
		return cursors;
	}
}
