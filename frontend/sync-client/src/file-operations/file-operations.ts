import type { Logger } from "../tracing/logger";
import type { FileSystemOperations } from "./filesystem-operations";
import type { RelativePath } from "../sync-operations/types";
import { SafeFileSystemOperations } from "./safe-filesystem-operations";
import type { TextWithCursors } from "reconcile-text";
import { reconcile } from "reconcile-text";
import { isFileTypeMergable } from "../utils/is-file-type-mergable";
import { isBinary } from "../utils/is-binary";
import type { ServerConfig } from "../services/server-config";
import { FileNotFoundError } from "../errors/file-not-found-error";
import { FileAlreadyExistsError } from "../errors/file-already-exists-error";

export class FileOperations {
    private readonly fs: SafeFileSystemOperations;

    public constructor(
        private readonly logger: Logger,
        fs: FileSystemOperations,
        private readonly serverConfig: ServerConfig,
        private readonly nativeLineEndings = "\n"
    ) {
        this.fs = new SafeFileSystemOperations(fs, logger);
    }

    private static getParentDirAndFileName(
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
        return this.fromNativeLineEndings(await this.fs.read(path));
    }

    /**
     * Create a file at the specified path.
     *
     * Throws `FileAlreadyExistsError` if a file already lives at `path`.
     * Parent directories are created if necessary. The reconciler is the
     * only caller that places files now and pre-checks for conflicts;
     * the throw guards against a TOCTOU race rather than being a normal
     * code path.
     */
    public async create(
        path: RelativePath,
        newContent: Uint8Array
    ): Promise<RelativePath> {
        if (await this.fs.exists(path)) {
            throw new FileAlreadyExistsError(
                `Refusing to create '${path}': file already exists`,
                path
            );
        }
        await this.createParentDirectories(path);

        await this.fs.write(path, this.toNativeLineEndings(newContent));
        return path;
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
        if (!(await this.fs.exists(path))) {
            this.logger.debug(
                `The caller assumed ${path} exists, but it no longer, so we wont recreate it`
            );
            return;
        }

        try {
            if (
                !isFileTypeMergable(
                    path,
                    (await this.serverConfig.getConfig())
                        .mergeableFileExtensions
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

            let expectedText = "";
            let newText = "";
            try {
                expectedText = new TextDecoder("utf-8", { fatal: true }).decode(
                    expectedContent
                ); // this comes from a previous read which must only have \n line endings
                newText = new TextDecoder("utf-8", { fatal: true }).decode(
                    newContent
                ); // this comes from the server which stores text with \n line endings
            } catch (decodeError) {
                this.logger.warn(
                    `3-way merge aborted for ${path}: one of expected/new is not valid UTF-8 (${decodeError}); falling back to overwrite`
                );
                await this.fs.write(path, this.toNativeLineEndings(newContent));
                return;
            }

            await this.fs.atomicUpdateText(
                path,
                ({ text, cursors }: TextWithCursors): TextWithCursors => {
                    this.logger.debug(
                        `Performing a 3-way merge for ${path} with the expected content`
                    );

                    text = text.replaceAll(this.nativeLineEndings, "\n");
                    const merged = reconcile(
                        expectedText,
                        { text, cursors },
                        newText
                    );

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
        } catch (e) {
            if (e instanceof FileNotFoundError) {
                this.logger.debug(
                    `File ${path} disappeared during write; not recreating`
                );
                return;
            }
            throw e;
        }
    }

    public async delete(path: RelativePath): Promise<void> {
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

    /**
     * Move the file at `oldPath` to `newPath`.
     *
     * Throws `FileAlreadyExistsError` if a file already lives at `newPath`
     * (and `oldPath !== newPath`). The reconciler is the only caller that
     * relocates tracked records and pre-checks for conflicts; the throw
     * guards against a TOCTOU race.
     */
    public async move(
        oldPath: RelativePath,
        newPath: RelativePath
    ): Promise<RelativePath> {
        if (oldPath === newPath) {
            return oldPath;
        }

        if (await this.fs.exists(newPath)) {
            throw new FileAlreadyExistsError(
                `Refusing to move '${oldPath}' onto '${newPath}': target already exists`,
                newPath
            );
        }
        await this.createParentDirectories(newPath);

        await this.fs.rename(oldPath, newPath);
        await this.deletingEmptyParentDirectoriesOfDeletedFile(oldPath);
        return newPath;
    }

    private async deletingEmptyParentDirectoriesOfDeletedFile(
        path: RelativePath
    ): Promise<void> {
        let directory = path;
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        while (true) {
            [directory] = FileOperations.getParentDirAndFileName(directory);
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
        if (isBinary(content)) {
            return content;
        }

        const decoder = new TextDecoder("utf-8");
        let text = decoder.decode(content);
        text = text.replaceAll(this.nativeLineEndings, "\n");
        return new TextEncoder().encode(text);
    }

    private toNativeLineEndings(content: Uint8Array): Uint8Array {
        if (isBinary(content)) {
            return content;
        }

        const decoder = new TextDecoder("utf-8");
        let text = decoder.decode(content);
        text = text.replaceAll("\n", this.nativeLineEndings);
        return new TextEncoder().encode(text);
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
}
