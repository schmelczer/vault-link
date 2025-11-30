import type { RelativePath, SyncSettings } from "sync-client";
import { MockClient } from "../agent/mock-client";
import { assert } from "../utils/assert";

export class DeterministicClient extends MockClient {
	private pendingOperations: (() => Promise<void>)[] = [];

	public constructor(
		public readonly clientId: string,
		initialSettings: Partial<SyncSettings>
	) {
		super(initialSettings, false);
	}

	/**
	 * Get the underlying SyncClient
	 */
	public getSyncClient() {
		return this.client;
	}

	/**
	 * Create a file with specific content
	 */
	public async createFile(
		path: RelativePath,
		content: string,
		immediate = true
	): Promise<void> {
		const operation = async (): Promise<void> => {
			await this.create(path, new TextEncoder().encode(content));
		};

		if (immediate) {
			await operation();
		} else {
			this.pendingOperations.push(operation);
		}
	}

	/**
	 * Update a file with new content (replaces all content)
	 */
	public async updateFile(
		path: RelativePath,
		content: string,
		immediate = true
	): Promise<void> {
		const operation = async (): Promise<void> => {
			await this.write(path, new TextEncoder().encode(content));
		};

		if (immediate) {
			await operation();
		} else {
			this.pendingOperations.push(operation);
		}
	}

	/**
	 * Append content to a file
	 */
	public async appendToFile(
		path: RelativePath,
		content: string,
		immediate = true
	): Promise<void> {
		const operation = async (): Promise<void> => {
			await this.atomicUpdateText(path, (current) => ({
				text: current.text + content,
				cursors: []
			}));
		};

		if (immediate) {
			await operation();
		} else {
			this.pendingOperations.push(operation);
		}
	}

	/**
	 * Delete a file
	 */
	public async deleteFile(
		path: RelativePath,
		immediate = true
	): Promise<void> {
		const operation = async (): Promise<void> => {
			await this.delete(path);
		};

		if (immediate) {
			await operation();
		} else {
			this.pendingOperations.push(operation);
		}
	}

	/**
	 * Rename a file
	 */
	public async renameFile(
		oldPath: RelativePath,
		newPath: RelativePath,
		immediate = true
	): Promise<void> {
		const operation = async (): Promise<void> => {
			await this.rename(oldPath, newPath);
		};

		if (immediate) {
			await operation();
		} else {
			this.pendingOperations.push(operation);
		}
	}

	/**
	 * Flush all pending operations
	 */
	public async flush(): Promise<void> {
		const operations = [...this.pendingOperations];
		this.pendingOperations = [];

		for (const operation of operations) {
			await operation();
		}
	}

	/**
	 * Wait until all sync operations are complete
	 */
	public async waitForSync(): Promise<void> {
		await this.client.waitUntilFinished();
	}

	/**
	 * Enable or disable sync
	 */
	public async setSyncEnabled(enabled: boolean): Promise<void> {
		await this.client.setSetting("isSyncEnabled", enabled);
	}

	/**
	 * Get file content as string
	 */
	public async getFileContent(path: RelativePath): Promise<string> {
		const content = await this.read(path);
		return new TextDecoder().decode(content);
	}

	/**
	 * Get number of files
	 */
	public async getFileCount(): Promise<number> {
		const files = await this.listFilesRecursively();
		return files.length;
	}

	/**
	 * Assert file exists or doesn't exist
	 */
	public async assertFileExists(
		path: RelativePath,
		shouldExist: boolean
	): Promise<void> {
		const exists = await this.exists(path);
		assert(
			exists === shouldExist,
			`[${this.clientId}] Expected file ${path} to ${shouldExist ? "exist" : "not exist"}, but it ${exists ? "exists" : "doesn't exist"}`
		);
	}

	/**
	 * Assert file content matches expected
	 */
	public async assertFileContent(
		path: RelativePath,
		expectedContent: string
	): Promise<void> {
		const content = await this.getFileContent(path);
		assert(
			content === expectedContent,
			`[${this.clientId}] Expected file ${path} to have content "${expectedContent}", but it has "${content}"`
		);
	}

	/**
	 * Assert file count matches expected
	 */
	public async assertFileCount(expectedCount: number): Promise<void> {
		const count = await this.getFileCount();
		assert(
			count === expectedCount,
			`[${this.clientId}] Expected ${expectedCount} files, but found ${count}`
		);
	}

	/**
	 * Check if this client's filesystem is consistent with another client
	 */
	public async assertConsistentWith(
		otherClient: DeterministicClient
	): Promise<void> {
		const thisFiles = await this.listFilesRecursively();
		const otherFiles = await otherClient.listFilesRecursively();

		const thisFilesSet = new Set(thisFiles);
		const otherFilesSet = new Set(otherFiles);

		const missingInOther = thisFiles.filter((f) => !otherFilesSet.has(f));
		const missingInThis = otherFiles.filter((f) => !thisFilesSet.has(f));

		assert(
			missingInOther.length === 0,
			`[${this.clientId}] Files missing in ${otherClient.clientId}: ${missingInOther.join(", ")}`
		);
		assert(
			missingInThis.length === 0,
			`[${this.clientId}] Files missing in this client from ${otherClient.clientId}: ${missingInThis.join(", ")}`
		);

		// Check content of all files
		for (const file of thisFiles) {
			const thisContent = await this.getFileContent(file);
			const otherContent = await otherClient.getFileContent(file);
			assert(
				thisContent === otherContent,
				`[${this.clientId}] Content mismatch for ${file}:\n  This: "${thisContent}"\n  Other: "${otherContent}"`
			);
		}
	}

	/**
	 * Cleanup
	 */
	public async destroy(): Promise<void> {
		await this.client.destroy();
	}
}
