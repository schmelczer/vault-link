import type { RelativePath } from "../persistence/database";

export class FileChangeNotifier {
	private readonly listeners: ((filePath: RelativePath) => unknown)[] = [];

	public addFileChangeListener(
		listener: (filePath: RelativePath) => unknown
	): void {
		this.listeners.push(listener);
	}

	public notifyOfFileChange(filePath: RelativePath): void {
		this.listeners.forEach((listener) => listener(filePath));
	}
}
