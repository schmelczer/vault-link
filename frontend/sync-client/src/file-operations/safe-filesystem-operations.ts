import type { RelativePath } from "../sync-operations/types";
import type { FileSystemOperations } from "./filesystem-operations";
import type { Logger } from "../tracing/logger";
import { FileNotFoundError } from "../errors/file-not-found-error";
import type { TextWithCursors } from "reconcile-text";

/**
 * Decorates `FileSystemOperations` to replace errors with `FileNotFoundError`
 * if the accessed file doesn't exist.
 */
export class SafeFileSystemOperations implements FileSystemOperations {
    public constructor(
        private readonly fs: FileSystemOperations,
        private readonly logger: Logger
    ) {}

    public async listFilesRecursively(
        root: RelativePath | undefined
    ): Promise<RelativePath[]> {
        this.logger.debug("Listing all files");
        const result = await this.fs.listFilesRecursively(root);
        this.logger.debug(`Listed ${result.length} files`);
        return result;
    }

    public async read(path: RelativePath): Promise<Uint8Array> {
        this.logger.debug(`Reading file '${path}'`);
        return this.safeOperation(path, async () => this.fs.read(path), "read");
    }

    public async write(path: RelativePath, content: Uint8Array): Promise<void> {
        this.logger.debug(`Writing to file '${path}'`);
        return this.fs.write(path, content);
    }

    public async atomicUpdateText(
        path: RelativePath,
        updater: (current: TextWithCursors) => TextWithCursors
    ): Promise<string> {
        this.logger.debug(`Atomically updating file '${path}'`);
        return this.safeOperation(
            path,
            async () => this.fs.atomicUpdateText(path, updater),
            "atomicUpdateText"
        );
    }

    public async getFileSize(path: RelativePath): Promise<number> {
        // Logging this would be too noisy
        return this.safeOperation(
            path,
            async () => this.fs.getFileSize(path),
            "getFileSize"
        );
    }

    public async exists(path: RelativePath): Promise<boolean> {
        this.logger.debug(`Checking if file '${path}' exists`);
        return this.fs.exists(path);
    }

    public async createDirectory(path: RelativePath): Promise<void> {
        this.logger.debug(`Creating directory '${path}'`);
        return this.fs.createDirectory(path);
    }

    public async delete(path: RelativePath): Promise<void> {
        this.logger.debug(`Deleting file '${path}'`);
        return this.fs.delete(path);
    }

    public async rename(
        oldPath: RelativePath,
        newPath: RelativePath
    ): Promise<void> {
        this.logger.debug(`Renaming file '${oldPath}' to '${newPath}'`);
        return this.safeOperation(
            oldPath,
            async () => this.fs.rename(oldPath, newPath),
            "rename"
        );
    }

    /**
     * Decorate an operation to ensure that the file exists before running it.
     * If the operation fails, it will check if the file still exists and throw
     * a FileNotFoundError if it doesn't.
     */
    private async safeOperation<T>(
        path: RelativePath,
        operation: () => Promise<T>,
        operationName: string
    ): Promise<T> {
        if (!(await this.fs.exists(path))) {
            throw new FileNotFoundError(
                `File not found before trying to ${operationName}`,
                path
            );
        }

        try {
            return await operation();
        } catch (error) {
            if (await this.fs.exists(path)) {
                throw error;
            } else {
                throw new FileNotFoundError(
                    `File not found when trying to ${operationName}`,
                    path
                );
            }
        }
    }
}
