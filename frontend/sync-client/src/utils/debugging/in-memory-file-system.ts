import type { RelativePath } from "../../sync-operations/types";
import type { TextWithCursors } from "reconcile-text";
import type { FileSystemOperations } from "../../file-operations/filesystem-operations";

export class InMemoryFileSystem implements FileSystemOperations {
    protected readonly files = new Map<string, Uint8Array>();

    public async listFilesRecursively(
        _root: RelativePath | undefined = undefined // we don't use multi-level paths during tests
    ): Promise<RelativePath[]> {
        return Array.from(this.files.keys());
    }

    public async read(path: RelativePath): Promise<Uint8Array> {
        const file = this.files.get(path);
        if (!file) {
            throw new Error(`File ${path} does not exist`);
        }
        return file;
    }

    public async write(path: RelativePath, content: Uint8Array): Promise<void> {
        this.files.set(path, content);
    }

    public async atomicUpdateText(
        path: RelativePath,
        updater: (current: TextWithCursors) => TextWithCursors
    ): Promise<string> {
        const file = this.files.get(path);
        if (!file) {
            throw new Error(`File ${path} does not exist`);
        }
        const currentContent = new TextDecoder().decode(file);
        const newContent = updater({ text: currentContent, cursors: [] }).text;
        this.files.set(path, new TextEncoder().encode(newContent));
        return newContent;
    }

    public async getFileSize(path: RelativePath): Promise<number> {
        return (await this.read(path)).length;
    }

    public async exists(path: RelativePath): Promise<boolean> {
        return this.files.has(path);
    }

    public async createDirectory(_path: RelativePath): Promise<void> {
        // This doesn't mean anything in our virtual FS representation
    }

    public async delete(path: RelativePath): Promise<void> {
        this.files.delete(path);
    }

    public async rename(
        oldPath: RelativePath,
        newPath: RelativePath
    ): Promise<void> {
        const file = this.files.get(oldPath);
        if (!file) {
            throw new Error(`File ${oldPath} does not exist`);
        }
        this.files.set(newPath, file);
        if (oldPath !== newPath) {
            this.files.delete(oldPath);
        }
    }
}
