import type { RelativePath } from "../persistence/database";

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
		const index = this.listeners.indexOf(listener);
		if (index !== -1) {
			this.listeners.splice(index, 1);
		}
	}

	public notifyOfFileChange(filePath: RelativePath): void {
		this.listeners.forEach((listener) => listener(filePath));
	}
}
