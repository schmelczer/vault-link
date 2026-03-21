import type { Logger } from "../tracing/logger";
import type { FileSystemOperations } from "./filesystem-operations";
import type { RelativePath } from "../persistence/database";
import type { VirtualFilesystem } from "../persistence/vfs";
import { SafeFileSystemOperations } from "./safe-filesystem-operations";
import type { TextWithCursors } from "reconcile-text";
import { reconcile } from "reconcile-text";
import { isFileTypeMergable } from "../utils/is-file-type-mergable";
import { isBinary } from "../utils/is-binary";
import { decodeText, normalizeToUtf8 } from "../utils/decode-text";
import type { ServerConfig } from "../services/server-config";
import { validateRelativePath } from "../utils/validate-relative-path";

export class FileOperations {
    private static readonly PARENTHESES_REGEX = / \((?<count>\d+)\)$/;
    private readonly fs: SafeFileSystemOperations;

    public constructor(
        private readonly logger: Logger,
        private readonly vfs: VirtualFilesystem,
        fs: FileSystemOperations,
        private readonly serverConfig: ServerConfig,
        private readonly nativeLineEndings = "\n"
    ) {
        this.fs = new SafeFileSystemOperations(fs, logger);
    }

    private static getParentDirAndFile(
        path: RelativePath
    ): [RelativePath, RelativePath] {
        const pathParts = path.split("/");
        const fileName = pathParts.pop();
        if (fileName == null || fileName === "") {
            throw new Error(`Path '${path}' cannot be empty`);
        }

        return [pathParts.join("/"), fileName];
    }

    public async listFilesRecursively(
        root: RelativePath | undefined = undefined
    ): Promise<RelativePath[]> {
        return this.fs.listFilesRecursively(root);
    }

    public async read(path: RelativePath): Promise<Uint8Array> {
        const raw = await this.fs.read(path);
        return this.fromNativeLineEndings(normalizeToUtf8(raw));
    }

    /**
     * Create a file at the specified path.
     *
     * If a file with the same name already exists, it is moved before creating the new one.
     * Parent directories are created if necessary.
     */
    public async create(
        path: RelativePath,
        newContent: Uint8Array
    ): Promise<void> {
        validateRelativePath(path);
        await this.ensureClearPath(path);
        return this.fs.write(path, this.toNativeLineEndings(newContent));
    }

    public async ensureClearPath(path: RelativePath): Promise<RelativePath | undefined> {
        validateRelativePath(path);
        // Acquire the lock on `path` first, then check existence inside the
        // lock.  The previous code checked exists() before locking, which
        // created a TOCTOU race: two concurrent calls could both see the
        // file as existing, but the second one would try to rename a file
        // that was already moved by the first.
        await this.fs.waitForLock(path);
        try {
            return await this.ensureClearPathLocked(path);
        } finally {
            this.fs.unlock(path);
        }
    }

    /**
     * Internal implementation of `ensureClearPath` that assumes the caller
     * already holds the file-level lock on `path`. This allows callers like
     * `move()` to keep the lock held across both the clear and the subsequent
     * rename, closing the race window where another operation could create a
     * file at `path` between the two steps.
     */
    private async ensureClearPathLocked(
        path: RelativePath
    ): Promise<RelativePath | undefined> {
        if (await this.fs.exists(path, true)) {
            const deconflictedPath = await this.deconflictPath(path);
            try {
                this.logger.debug(
                    `Didn't expect ${path} to exist, deconflicting by moving it to '${deconflictedPath}'`
                );

                // deconflictedPath is already locked via tryLock in
                // deconflictPath(), so we pass skipLock=true to the
                // rename to avoid deadlocking on the destination lock.
                await this.fs.rename(path, deconflictedPath, true);
                try {
                    this.vfs.move(path, deconflictedPath);

                    // Tell the sync system this displacement is system-initiated
                    // (not a user rename) by setting remoteRelativePath to the
                    // deconflicted path. This makes the check in
                    // syncLocallyUpdatedFile (remoteRelativePath === relativePath)
                    // pass, preventing the displacement from being uploaded as a
                    // rename to the server. Without this, the rename event from
                    // fs.rename() triggers an update with the deconflicted path,
                    // the server deconflicts further, and an infinite cascade
                    // ensues. The force:true content-match shortcut ensures that
                    // when the server eventually broadcasts the document's real
                    // path, the client just updates metadata without moving the
                    // file back.
                    const displacedDoc =
                        this.vfs.getByPath(deconflictedPath);
                    if (
                        displacedDoc?.state === "tracked" &&
                        displacedDoc.remoteRelativePath !== undefined
                    ) {
                        displacedDoc.remoteRelativePath =
                            deconflictedPath;
                    }
                } catch (e) {
                    // vfs.move() failed (e.g., a non-deleted document
                    // already exists at deconflictedPath). Revert the
                    // filesystem rename to keep file and VFS
                    // consistent. If the revert also fails, log it —
                    // scheduleSyncForOfflineChanges will reconcile.
                    this.logger.warn(
                        `vfs.move(${path}, ${deconflictedPath}) failed in ensureClearPath: ${e}, reverting filesystem rename`
                    );
                    try {
                        await this.fs.rename(deconflictedPath, path, true);
                    } catch (revertError) {
                        this.logger.warn(
                            `Failed to revert filesystem rename from ${deconflictedPath} to ${path}: ${revertError}`
                        );
                    }
                    throw e;
                }
            } finally {
                this.fs.unlock(deconflictedPath);
            }
            return deconflictedPath;
        } else {
            await this.createParentDirectories(path);
            return undefined;
        }
    }

    /**
     * Update the file at the given path.
     *
     * Performs a 3-way merge before writing if the file's content differs from `expectedContent`.
     * Does not recreate the file if it no longer exists, returning an empty array instead.
     */
    public async write(
        path: RelativePath,
        expectedContent: Uint8Array,
        newContent: Uint8Array
    ): Promise<void> {
        validateRelativePath(path);
        if (!(await this.fs.exists(path))) {
            this.logger.debug(
                `The caller assumed ${path} exists, but it no longer, so we wont recreate it`
            );
            return;
        }

        if (
            !isFileTypeMergable(
                path,
                (await this.serverConfig.getConfig()).mergeableFileExtensions
            ) ||
            isBinary(expectedContent) ||
            isBinary(newContent)
        ) {
            this.logger.debug(
                `The expected content is not mergable, so we won't perform a 3-way merge, just overwrite it`
            );
            await this.fs.write(
                path,
                // `newContent` might not be binary so we still have to ensure the line endings are correct
                this.toNativeLineEndings(newContent)
            );
            return;
        }

        const expectedText = (decodeText(expectedContent) ?? "").normalize(
            "NFC"
        ); // this comes from a previous read which must only have \n line endings
        const newText = (decodeText(newContent) ?? "").normalize("NFC"); // this comes from the server which stores text with \n line endings

        await this.fs.atomicUpdateText(
            path,
            ({ text, cursors }: TextWithCursors): TextWithCursors => {
                this.logger.debug(
                    `Performing a 3-way merge for ${path} with the expected content`
                );

                text = text
                    .replaceAll(this.nativeLineEndings, "\n")
                    .normalize("NFC");

                let merged: TextWithCursors;
                try {
                    merged = reconcile(
                        expectedText,
                        { text, cursors },
                        newText,
                        "Markdown"
                    );
                } catch {
                    // 3-way merge failed (e.g., content was fully replaced
                    // by another agent). Save the local content as a conflict
                    // file before overwriting with the server's content, so
                    // the user's edits are never silently lost.
                    this.logger.info(
                        `3-way merge failed for ${path}, saving local content as conflict file and using server content`
                    );
                    this.saveConflictFile(path, text);
                    merged = { text: newText, cursors: [] };
                }

                const resultText = merged.text.replaceAll(
                    "\n",
                    this.nativeLineEndings
                );

                return {
                    text: resultText,
                    cursors: merged.cursors
                };
            }
        );
    }

    public async delete(path: RelativePath): Promise<void> {
        validateRelativePath(path);
        if (await this.exists(path)) {
            await this.fs.delete(path);
            await this.deletingEmptyParentDirectoriesOfDeletedFile(path);
        } else {
            this.logger.debug(`No need to delete '${path}', it doesn't exist`);
        }
    }

    public async getFileSize(path: RelativePath): Promise<number> {
        return this.fs.getFileSize(path);
    }

    public async exists(path: RelativePath): Promise<boolean> {
        return this.fs.exists(path);
    }

    public async move(
        oldPath: RelativePath,
        newPath: RelativePath
    ): Promise<void> {
        validateRelativePath(oldPath);
        validateRelativePath(newPath);
        if (oldPath === newPath) {
            return;
        }

        // Hold the newPath lock across both ensureClearPath and rename.
        // Without this, another operation could create a file at newPath
        // between ensureClearPath releasing the lock and rename acquiring
        // it, causing the rename to silently overwrite the new file.
        await this.fs.waitForLock(newPath);
        try {
            await this.ensureClearPathLocked(newPath);
            // skipLock=true because we already hold the newPath lock.
            // The oldPath lock is not needed; sync operations run
            // sequentially so no concurrent operation can race on paths.
            await this.fs.rename(oldPath, newPath, true);
        } finally {
            this.fs.unlock(newPath);
        }
        try {
            this.vfs.move(oldPath, newPath);
        } catch (e) {
            // vfs.move() failed (e.g., a non-deleted document already
            // exists at newPath). Revert the filesystem rename to keep the
            // file and VFS consistent. If the revert also fails, log
            // it — scheduleSyncForOfflineChanges will reconcile on the
            // next cycle.
            this.logger.warn(
                `vfs.move(${oldPath}, ${newPath}) failed: ${e}, reverting filesystem rename`
            );
            try {
                await this.fs.rename(newPath, oldPath);
            } catch (revertError) {
                this.logger.warn(
                    `Failed to revert filesystem rename from ${newPath} to ${oldPath}: ${revertError}`
                );
            }
            throw e;
        }

        await this.deletingEmptyParentDirectoriesOfDeletedFile(oldPath);
    }

    public reset(): void {
        this.fs.reset();
    }

    private async deletingEmptyParentDirectoriesOfDeletedFile(
        path: RelativePath
    ): Promise<void> {
        let directory = path;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        while (true) {
            [directory] = FileOperations.getParentDirAndFile(directory);
            if (directory.length === 0) {
                break;
            }

            const remainingContent =
                await this.fs.listFilesRecursively(directory);
            if (remainingContent.length === 0) {
                this.logger.debug(
                    `Folder (${directory}) is now empty, deleting`
                );
                await this.fs.delete(directory);
            } else {
                break;
            }
        }
    }

    private fromNativeLineEndings(content: Uint8Array): Uint8Array {
        const text = decodeText(content);
        if (text === undefined) {
            return content;
        }

        const normalized = text.replaceAll(this.nativeLineEndings, "\n");
        return new TextEncoder().encode(normalized);
    }

    private toNativeLineEndings(content: Uint8Array): Uint8Array {
        const text = decodeText(content);
        if (text === undefined) {
            return content;
        }

        const normalized = text.replaceAll("\n", this.nativeLineEndings);
        return new TextEncoder().encode(normalized);
    }

    /**
     * Save the local content of a file as a conflict file when 3-way merge
     * fails, so the user's edits are never silently lost. The conflict file
     * is created at a deconflicted path (e.g., "file (conflict 1).md").
     *
     * This is fire-and-forget — errors are logged but do not prevent the
     * caller from proceeding with the server's content.
     */
    private saveConflictFile(
        path: RelativePath,
        localContent: string
    ): void {
        const contentBytes = new TextEncoder().encode(
            localContent.replaceAll("\n", this.nativeLineEndings)
        );
        // Fire-and-forget: we don't want a failed conflict-save to prevent
        // the server content from being written.
        void (async () => {
            try {
                const conflictPath =
                    await this.deconflictPath(path);
                try {
                    await this.fs.write(conflictPath, contentBytes);
                    this.logger.info(
                        `Saved local content as conflict file: ${conflictPath}`
                    );
                } finally {
                    this.fs.unlock(conflictPath);
                }
            } catch (e) {
                this.logger.warn(
                    `Failed to save conflict file for ${path}: ${e}`
                );
            }
        })();
    }

    private async createParentDirectories(path: string): Promise<void> {
        const components = path.split("/");
        if (components.length === 1) {
            return;
        }
        for (let i = 1; i < components.length; i++) {
            const parentDir = components.slice(0, i).join("/");
            if (!(await this.fs.exists(parentDir))) {
                await this.fs.createDirectory(parentDir);
            }
        }
    }

    /**
     * Deconflicts the given path by appending (1), (2), etc. before the file extension until a non-existent path is found.
     * The returned path has a lock acquired on it; it must be released by the caller when no longer needed.
     *
     * @param path The starting path to deconflict
     * @returns a non-existent path with a lock acquired on it
     */
    private async deconflictPath(path: RelativePath): Promise<RelativePath> {
        // eslint-disable-next-line prefer-const
        let [directory, fileName] = FileOperations.getParentDirAndFile(path);

        if (directory) {
            directory += "/";
        }

        const nameParts = fileName.split(".");
        // Handle dotfiles: ".gitignore" should have no extension, ".config.json" should have ".json"
        const isDotfile = fileName.startsWith(".") && nameParts[0] === "";
        const extension =
            nameParts.length > 1 && !(isDotfile && nameParts.length === 2)
                ? "." + nameParts[nameParts.length - 1]
                : "";
        let stem = extension ? nameParts.slice(0, -1).join(".") : fileName;
        let currentCount = Number.parseInt(
            FileOperations.PARENTHESES_REGEX.exec(stem)?.groups?.count ?? "0"
        );
        stem = stem.replace(FileOperations.PARENTHESES_REGEX, "");

        let newName = path;

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        while (true) {
            currentCount++;
            newName = `${directory}${stem} (${currentCount})${extension}`;

            // Avoid multiple deconflictPath calls returning the same path
            if (this.fs.tryLock(newName)) {
                // getByPath only returns live docs (pending/tracked), not
                // deleted-locally ones, so a non-undefined result means
                // the path is occupied.
                const existingDoc = this.vfs.getByPath(newName);
                if (
                    existingDoc !== undefined || // the document might have been confirmed by the server at a new path but haven't yet moved there locally
                    (await this.fs.exists(newName, true))
                ) {
                    this.fs.unlock(newName);
                } else {
                    return newName;
                }
            }
        }
    }
}
