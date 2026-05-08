import type { RelativePath } from "./types";
import { EventListeners } from "../utils/data-structures/event-listeners";

export class FileChangeNotifier {
    public readonly onFileChanged = new EventListeners<
        (filePath: RelativePath) => unknown
    >();

    public notifyOfFileChange(filePath: RelativePath): void {
        this.onFileChanged.trigger(filePath);
    }
}
