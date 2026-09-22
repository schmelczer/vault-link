import type { Editor } from "obsidian";
import {
    utils,
    type FileSystemOperations,
    type FileSnapshot
} from "sync-client";
import { getSelectionsFromEditor } from "./views/cursors/get-selections-from-editor";

/** Editor contents and selections are one synchronous snapshot. Disk namespace
 * operations remain the responsibility of the platform adapter. */
export class ObsidianFileSystemOperations implements FileSystemOperations {
    public constructor(
        private readonly disk: FileSystemOperations,
        private readonly activeEditor: () =>
            | { path: string; editor: Editor }
            | undefined
    ) {}

    public async listFilesRecursively(root?: string): Promise<string[]> {
        return this.disk.listFilesRecursively(root);
    }
    public async exists(path: string): Promise<boolean> {
        return this.disk.exists(path);
    }
    public async createDirectory(path: string): Promise<void> {
        return this.disk.createDirectory(path);
    }
    public async delete(path: string): Promise<void> {
        return this.disk.delete(path);
    }
    public async deleteFile(path: string): Promise<void> {
        return this.disk.deleteFile(path);
    }
    public async rename(from: string, to: string): Promise<void> {
        const snapshot = await this.readSnapshot(from);
        if (!snapshot) throw new Error(`Missing source: ${from}`);
        await this.write(to, snapshot);
        const current = await this.readSnapshot(from);
        if (
            !current ||
            current.content.length !== snapshot.content.length ||
            current.content.some((byte, i) => byte !== snapshot.content[i])
        )
            throw new Error(`Source changed during move: ${from}`);
        await this.deleteFile(from);
    }

    public async stat(path: string): ReturnType<FileSystemOperations["stat"]> {
        const entry = await this.disk.stat(path);
        const view = this.activeEditor();
        if (entry?.kind === "file" && view?.path === path)
            return {
                ...entry,
                size: new TextEncoder().encode(view.editor.getValue())
                    .byteLength
            };
        return entry;
    }

    public async readSnapshot(path: string): Promise<FileSnapshot | undefined> {
        // Validate the disk path even when an editor is open.
        const entry = await this.disk.stat(path);
        if (!entry) return undefined;
        const view = this.activeEditor();
        if (entry.kind === "file" && view?.path === path) {
            return {
                content: new TextEncoder().encode(view.editor.getValue()),
                cursors: getSelectionsFromEditor(view.editor).flatMap(
                    ({ id, start, end }) => [
                        { id: 2 * id, position: start },
                        { id: 2 * id + 1, position: end }
                    ]
                )
            };
        }
        return this.disk.readSnapshot(path);
    }

    public async write(path: string, snapshot: FileSnapshot): Promise<void> {
        await this.disk.write(path, snapshot);
        const view = this.activeEditor();
        if (view?.path !== path) return;
        const text = new TextDecoder().decode(snapshot.content);
        view.editor.setValue(text);
        const cursors = [...(snapshot.cursors ?? [])].sort(
            (a, b) => a.id - b.id
        );
        const selections = [];
        for (let i = 0; i + 1 < cursors.length; i += 2) {
            const anchor = utils.positionToLineAndColumn(
                text,
                cursors[i].position
            );
            const head = utils.positionToLineAndColumn(
                text,
                cursors[i + 1].position
            );
            selections.push({
                anchor: { line: anchor.line, ch: anchor.column },
                head: { line: head.line, ch: head.column }
            });
        }
        if (selections.length) view.editor.setSelections(selections);
    }
}
