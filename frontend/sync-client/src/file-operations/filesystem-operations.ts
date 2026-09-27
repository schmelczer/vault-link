import type { TextWithCursors } from "reconcile-text";
import type { RelativePath } from "../persistence/database";
import type { FileSnapshot } from "../snapshot";

/** Filesystem operations act on the current user-owned namespace.
 * Paths are vault-relative. Never follow symlinks (including ancestor symlinks).
 * Only independent regular files are supported; reject hardlinks/special files.
 */
export interface FileSystemOperations {
    listFilesRecursively: (root?: RelativePath) => Promise<RelativePath[]>;

    /** Return undefined on missing file */
    read: (path: RelativePath) => Promise<FileSnapshot | undefined>;

    /** File size in in bytes. */
    stat: (
        path: RelativePath
    ) => Promise<{ kind: "file" | "directory"; size: number } | undefined>;

    /** Includes directories. */
    exists: (path: RelativePath) => Promise<boolean>;

    /** Recursive, idempotent directory creation. */
    createDirectory: (path: RelativePath) => Promise<void>;

    /** Create or overwrite a file, applying optional editor cursor metadata. */
    write: (path: RelativePath, snapshot: FileSnapshot) => Promise<void>;

    // Atomically update the content of a text file.
    atomicUpdateText: (
        path: RelativePath,
        updater: (current: TextWithCursors) => TextWithCursors
    ) => Promise<string>;

    /** Move a file without replacing an existing destination. */
    rename: (from: RelativePath, to: RelativePath) => Promise<void>;

    /** Idempotently unlink one regular file. */
    deleteFile: (path: RelativePath) => Promise<void>;

    /** Prune directories using rmdir only. Reject files and nonempty directories. */
    deleteDirectory: (path: RelativePath) => Promise<void>;
}
