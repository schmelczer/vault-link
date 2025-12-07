import type { RelativePath } from "../persistence/database";

import type { TextWithCursors } from "reconcile-text";

export interface FileSystemOperations {
    // List all files under root that should be synced. If root is undefined, return every file.
    listFilesRecursively: (
        root: RelativePath | undefined
    ) => Promise<RelativePath[]>;

    // Read the content of a file.
    read: (path: RelativePath) => Promise<Uint8Array>;

    // Create or overwrite a file with the given content.
    write: (path: RelativePath, content: Uint8Array) => Promise<void>;

    // Atomically update the content of a text file.
    atomicUpdateText: (
        path: RelativePath,
        updater: (current: TextWithCursors) => TextWithCursors
    ) => Promise<string>;

    // Get the size of a file in bytes.
    getFileSize: (path: RelativePath) => Promise<number>;

    // Check if a file exists.
    exists: (path: RelativePath) => Promise<boolean>;

    // Create a directory at the specified path. All parent directories must already exist.
    createDirectory: (path: RelativePath) => Promise<void>;

    // Delete a file. It is expected that the path points to an existing file.
    delete: (path: RelativePath) => Promise<void>;

    // Rename a file. It is expected that the oldPath points to an existing file and the newPath does not exist.
    rename: (oldPath: RelativePath, newPath: RelativePath) => Promise<void>;
}
