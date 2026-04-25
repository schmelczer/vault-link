import type { Logger } from "../tracing/logger";
import type { FileSystemOperations } from "./filesystem-operations";
import type { RelativePath } from "../sync-operations/types";
import type { SyncEventQueue } from "../sync-operations/sync-event-queue";
import { SafeFileSystemOperations } from "./safe-filesystem-operations";
import type { TextWithCursors } from "reconcile-text";
import { reconcile } from "reconcile-text";
import { isFileTypeMergable } from "../utils/is-file-type-mergable";
import { isBinary } from "../utils/is-binary";
import { buildConflictFileName } from "../sync-operations/conflict-path";
import type { ServerConfig } from "../services/server-config";


export enum MoveOnConflict {
    EXISTING = "EXISTING",
    NEW = "NEW",
}

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
        return this.fromNativeLineEndings(await this.fs.read(path));
    }

    /**
     * Create a file at the specified path.
     *
     * If a file with the same name already exists, it is moved before creating the new one.
     * Parent directories are created if necessary.
     * 
     * Returns the actual path the file was created at.
     */
    public async create(
        path: RelativePath,
        newContent: Uint8Array,
        moveOnConflict: MoveOnConflict
    ): Promise<RelativePath> {
        const actualPath = await this.ensureClearPath(path, moveOnConflict);
        await this.fs.write(actualPath, this.toNativeLineEndings(newContent));
        return actualPath;
    }

    private async ensureClearPath(
        path: RelativePath,
        moveOnConflict: MoveOnConflict
    ): Promise<RelativePath> {
        if (await this.fs.exists(path)) {
            const conflictPath = FileOperations.buildConflictPath(path);

            if (moveOnConflict === MoveOnConflict.NEW) {
                return conflictPath;
            }

            this.logger.debug(
                `Displacing existing file at ${path} to '${conflictPath}' to make room`
            );

            await this.fs.rename(path, conflictPath);
            return path;
        }

        this.logger.debug(`No existing file at ${path}, creating parent directories if needed`);
        await this.createParentDirectories(path);
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

        let expectedText: string;
        let newText: string;
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

    // Returns the actual path the file got moved to.
    public async move(
        oldPath: RelativePath,
        newPath: RelativePath,
        moveOnConflict: MoveOnConflict
    ): Promise<RelativePath> {
        if (oldPath === newPath) {
            return oldPath;
        }

        const actualPath = await this.ensureClearPath(newPath, moveOnConflict);
        await this.fs.rename(oldPath, actualPath);
        await this.deletingEmptyParentDirectoriesOfDeletedFile(oldPath);
        return actualPath;
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

    /**
     * Build a local-only conflict path for a file the client has to set aside.
     * Format: `<dir>/conflict-<uuid>-<originalName>` — UUID makes collisions
     * statistically impossible, so no disk probe / lock dance is needed.
     */
    private static buildConflictPath(path: RelativePath): RelativePath {
        const [directory, fileName] =
            FileOperations.getParentDirAndFile(path);
        const conflictName = buildConflictFileName(fileName);
        return directory ? `${directory}/${conflictName}` : conflictName;
    }
}
