import type { Workspace } from "obsidian";
import { FileView, setIcon } from "obsidian";
import type { SyncClient } from "sync-client";
import { DocumentSyncStatus } from "sync-client";
import "./editor-status-display-manager.scss";
import type VaultLinkPlugin from "src/vault-link-plugin";
import { HistoryView } from "../history/history-view";

export class EditorStatusDisplayManager {
    private static readonly UPDATE_INTERVAL_IN_MS = 100;

    private readonly intervalId: NodeJS.Timeout;
    private readonly lastStatuses = new Map<string, DocumentSyncStatus>();

    public constructor(
        private readonly plugin: VaultLinkPlugin,
        private readonly workspace: Workspace,
        private readonly client: SyncClient
    ) {
        this.intervalId = setInterval(() => {
            this.updateEditorStatusDisplay();
        }, EditorStatusDisplayManager.UPDATE_INTERVAL_IN_MS);
    }

    public dispose(): void {
        clearInterval(this.intervalId);
    }

    private updateEditorStatusDisplay(): void {
        this.workspace.iterateAllLeaves((leaf) => {
            if (leaf.view instanceof FileView) {
                const filePath = leaf.view.file?.path;
                if (filePath == null) {
                    return;
                }

                const element = this.getElementFromLeaf(leaf.view);
                if (element == null) {
                    return;
                }

                const previousStatus = this.lastStatuses.get(filePath);
                const currentStatus =
                    this.client.getDocumentSyncingStatus(filePath);
                if (previousStatus === currentStatus) {
                    return;
                }
                this.lastStatuses.set(filePath, currentStatus);

                if (currentStatus == DocumentSyncStatus.SYNCING_IS_DISABLED) {
                    element.remove();
                    return;
                }

                if (currentStatus == DocumentSyncStatus.SYNCING) {
                    element.classList.add("loading");
                } else {
                    element.classList.remove("loading");
                }

                const iconContainer = element.querySelector(".icon");
                if (iconContainer != null) {
                    setIcon(
                        iconContainer as HTMLElement, // eslint-disable-line @typescript-eslint/no-unsafe-type-assertion
                        currentStatus == DocumentSyncStatus.SYNCING
                            ? "loader"
                            : "circle-check"
                    );
                }
            }
        });
    }

    private getElementFromLeaf(fileView: FileView): Element | undefined {
        const parent = fileView.contentEl.querySelector(".cm-editor");
        if (parent == null) {
            return;
        }

        return (
            parent.querySelector(".vault-link-sync-status") ??
            parent.createDiv(
                {
                    cls: "vault-link-sync-status"
                },
                (el) => {
                    el.createSpan({ text: "VaultLink sync state" });
                    el.createDiv({
                        cls: "icon"
                    });
                    el.onclick = async (): Promise<void> =>
                        this.plugin.activateView(HistoryView.TYPE);
                }
            )
        );
    }
}
