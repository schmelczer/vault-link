import "./file-explorer.scss";

import type { App, View } from "obsidian";
import {
    utils,
    type MaybeOutdatedClientCursors,
    type RelativePath
} from "sync-client";

const REMOTE_USER_CONTAINER_CLASS = "remote-users";

export function renderCursorsInFileExplorer(
    cursors: MaybeOutdatedClientCursors[],
    app: App
): void {
    const fileExplorers = app.workspace.getLeavesOfType("file-explorer");
    if (fileExplorers.length == 0) {
        return;
    }

    const [fileExplorer] = fileExplorers;

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const fileExplorerView: View & {
        fileItems: Record<RelativePath, { el: Element }>; // it's an internal API
    } = fileExplorer.view as any; // eslint-disable-line

    for (const key in fileExplorerView.fileItems) {
        const element =
            fileExplorerView.fileItems[key].el.querySelector(".tree-item-self");

        const customElement = createDiv(
            {
                cls: REMOTE_USER_CONTAINER_CLASS
            },
            (parent) => {
                cursors.forEach((cursor) => {
                    cursor.documentsWithCursors.forEach((document) => {
                        if (document.relative_path.startsWith(key)) {
                            parent.appendChild(
                                createSpan({
                                    text: cursor.userName,
                                    attr: {
                                        style: `border-color: ${utils.getRandomColor(cursor.userName)}`
                                    }
                                })
                            );
                        }
                    });
                });
            }
        );

        element?.querySelector("." + REMOTE_USER_CONTAINER_CLASS)?.remove();
        element?.appendChild(customElement);
    }
}
