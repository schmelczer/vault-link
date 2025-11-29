import type { RelativePath } from "../persistence/database";
import type { FileSystemOperations } from "./filesystem-operations";
import type { Logger } from "../tracing/logger";
import { Locks } from "../utils/data-structures/locks";
import { FileNotFoundError } from "./file-not-found-error";
import type { TextWithCursors } from "reconcile-text";

/**
 * Decorates `FileSystemOperations` to replace errors with `FileNotFoundError`
 * if the accessed file doesn't exist. It also ensures that there's at most a
 * single request in-flight for any one file through the use of locks.
 */
export class SafeFileSystemOperations implements FileSystemOperations {
	private readonly locks: Locks<RelativePath>;

	public constructor(
		private readonly fs: FileSystemOperations,
		private readonly logger: Logger
	) {
		this.locks = new Locks(logger);
	}

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
		return this.safeOperation(
			path,
			async () =>
				this.locks.withLock(path, async () => this.fs.read(path)),
			"read"
		);
	}

	public async write(path: RelativePath, content: Uint8Array): Promise<void> {
		this.logger.debug(`Writing to file '${path}'`);
		return this.locks.withLock(path, async () =>
			this.fs.write(path, content)
		);
	}

	public async atomicUpdateText(
		path: RelativePath,
		updater: (current: TextWithCursors) => TextWithCursors
	): Promise<string> {
		this.logger.debug(`Atomically updating file '${path}'`);
		return this.safeOperation(
			path,
			async () =>
				this.locks.withLock(path, async () =>
					this.fs.atomicUpdateText(path, updater)
				),
			"atomicUpdateText"
		);
	}

	public async getFileSize(path: RelativePath): Promise<number> {
		// Logging this would be too noisy
		return this.safeOperation(
			path,
			async () =>
				this.locks.withLock(path, async () =>
					this.fs.getFileSize(path)
				),
			"getFileSize"
		);
	}

	public async exists(
		path: RelativePath,
		skipLock: boolean = false
	): Promise<boolean> {
		this.logger.debug(`Checking if file '${path}' exists`);
		if (skipLock) {
			return this.fs.exists(path);
		} else {
			return this.locks.withLock(path, async () => this.fs.exists(path));
		}
	}

	public async createDirectory(path: RelativePath): Promise<void> {
		this.logger.debug(`Creating directory '${path}'`);
		return this.locks.withLock(path, async () =>
			this.fs.createDirectory(path)
		);
	}

	public async delete(path: RelativePath): Promise<void> {
		this.logger.debug(`Deleting file '${path}'`);
		return this.locks.withLock(path, async () => this.fs.delete(path));
	}

	public async rename(
		oldPath: RelativePath,
		newPath: RelativePath,
		skipLock: boolean = false
	): Promise<void> {
		this.logger.debug(`Renaming file '${oldPath}' to '${newPath}'`);
		return this.safeOperation(
			oldPath,
			async () => {
				if (skipLock) {
					return this.fs.rename(oldPath, newPath);
				} else {
					return this.locks.withLock([oldPath, newPath], async () =>
						this.fs.rename(oldPath, newPath)
					);
				}
			},
			"rename"
		);
	}

	public tryLock(path: RelativePath): boolean {
		return this.locks.tryLock(path);
	}

	public waitForLock(path: RelativePath) {
		return this.locks.waitForLock(path);
	}

	public unlock(path: RelativePath) {
		this.locks.unlock(path);
	}

	public reset(): void {
		this.locks.reset();
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
			// Without locking the file, this isn't atomic, however, it's good enough in practice.
			// This will only break if the file exists, gets deleted and then immediately
			// recreated while `operation` is running.
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
