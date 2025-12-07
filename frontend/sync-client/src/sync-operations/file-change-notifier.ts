import type { RelativePath } from "../persistence/database";
import { removeFromArray } from "../utils/remove-from-array";

export class FileChangeNotifier {
	private readonly listeners: ((filePath: RelativePath) => unknown)[] = [];

	public addFileChangeListener(
		listener: (filePath: RelativePath) => unknown
	): void {
		this.listeners.push(listener);
	}

	public removeFileChangeListener(
		listener: (filePath: RelativePath) => unknown
	): void {
		removeFromArray(this.listeners, listener);
	}

	public notifyOfFileChange(filePath: RelativePath): void {
		this.listeners.forEach((listener) => listener(filePath));
	}
}
