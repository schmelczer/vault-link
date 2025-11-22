import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as path from "path";
import type { FileSystemOperations, RelativePath } from "sync-client";

export class NodeFileSystemOperations implements FileSystemOperations {
	public constructor(private readonly basePath: string) {}

	public async listFilesRecursively(
		directory: RelativePath | undefined
	): Promise<RelativePath[]> {
		const files: RelativePath[] = [];
		await this.walkDirectory(
			directory !== undefined ? this.toNativePath(directory) : "",
			files
		);
		return files;
	}

	public async read(relativePath: RelativePath): Promise<Uint8Array> {
		const fullPath = path.join(
			this.basePath,
			this.toNativePath(relativePath)
		);
		try {
			return await fs.readFile(fullPath);
		} catch (error) {
			throw new Error(
				`Failed to read file ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	public async write(
		relativePath: RelativePath,
		content: Uint8Array
	): Promise<void> {
		const fullPath = path.join(
			this.basePath,
			this.toNativePath(relativePath)
		);
		const dir = path.dirname(fullPath);

		try {
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(fullPath, content);
		} catch (error) {
			throw new Error(
				`Failed to write file ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	public async atomicUpdateText(
		relativePath: RelativePath,
		updater: (current: TextWithCursors) => TextWithCursors
	): Promise<string> {
		const fullPath = path.join(
			this.basePath,
			this.toNativePath(relativePath)
		);

		try {
			const currentContent = await fs.readFile(fullPath, "utf-8");
			const result = updater({ text: currentContent, cursors: [] });
			await fs.writeFile(fullPath, result.text, "utf-8");
			return result.text;
		} catch (error) {
			throw new Error(
				`Failed to atomically update file ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	public async getFileSize(relativePath: RelativePath): Promise<number> {
		const fullPath = path.join(
			this.basePath,
			this.toNativePath(relativePath)
		);
		try {
			const stats = await fs.stat(fullPath);
			return stats.size;
		} catch (error) {
			throw new Error(
				`Failed to get file size for ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	public async exists(relativePath: RelativePath): Promise<boolean> {
		const fullPath = path.join(
			this.basePath,
			this.toNativePath(relativePath)
		);
		try {
			await fs.access(fullPath);
			return true;
		} catch {
			return false;
		}
	}

	public async createDirectory(relativePath: RelativePath): Promise<void> {
		const fullPath = path.join(
			this.basePath,
			this.toNativePath(relativePath)
		);
		try {
			await fs.mkdir(fullPath, { recursive: false });
		} catch (error) {
			throw new Error(
				`Failed to create directory ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	public async delete(relativePath: RelativePath): Promise<void> {
		const fullPath = path.join(
			this.basePath,
			this.toNativePath(relativePath)
		);
		try {
			await fs.unlink(fullPath);
		} catch (error) {
			throw new Error(
				`Failed to delete file ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	public async rename(
		oldPath: RelativePath,
		newPath: RelativePath
	): Promise<void> {
		const oldFullPath = path.join(
			this.basePath,
			this.toNativePath(oldPath)
		);
		const newFullPath = path.join(
			this.basePath,
			this.toNativePath(newPath)
		);
		const newDir = path.dirname(newFullPath);

		try {
			await fs.mkdir(newDir, { recursive: true });
			await fs.rename(oldFullPath, newFullPath);
		} catch (error) {
			throw new Error(
				`Failed to rename file from ${oldFullPath} to ${newFullPath}: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	}

	private async walkDirectory(
		relativePath: string,
		files: RelativePath[]
	): Promise<void> {
		const fullPath = path.join(this.basePath, relativePath);
		let entries: Dirent[] = [];

		try {
			entries = await fs.readdir(fullPath, { withFileTypes: true });
		} catch (error) {
			throw new Error(
				`Failed to read directory ${fullPath}: ${error instanceof Error ? error.message : String(error)}`
			);
		}

		for (const entry of entries) {
			const entryName = entry.name;
			const entryRelativePath = path.join(relativePath, entryName);

			if (entry.isDirectory()) {
				await this.walkDirectory(entryRelativePath, files);
			} else if (entry.isFile()) {
				// Always return forward slashes
				files.push(this.toUnixPath(entryRelativePath));
			}
		}
	}

	/**
	 * Convert a forward-slash path to native platform path separators
	 */
	private toNativePath(relativePath: string): string {
		if (path.sep === "\\") {
			return relativePath.replace(/\//g, "\\");
		}
		return relativePath;
	}

	/**
	 * Convert a native platform path to forward slashes
	 */
	private toUnixPath(nativePath: string): string {
		if (path.sep === "\\") {
			return nativePath.replace(/\\/g, "/");
		}
		return nativePath;
	}
}
