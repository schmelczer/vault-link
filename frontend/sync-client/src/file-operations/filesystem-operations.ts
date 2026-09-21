import type { CursorPosition } from "reconcile-text";

export interface FileSnapshot {
    content: Uint8Array;
    /** Optional editor selections, moved with the file and applied with its bytes. */
    cursors?: CursorPosition[];
}

/** Filesystem operations act on the current user-owned namespace.
 * Paths are vault-relative. Never follow symlinks (including ancestor symlinks).
 * Only independent regular files are supported; reject hardlinks/special files.
 * A successful scan is complete: unreadable directories must reject, not vanish.
 */
export interface FileSystemOperations {
    listFilesRecursively: (root?: string) => Promise<string[]>;
    /** Coherent content snapshot; undefined only for an absent file. Reject read races. */
    readSnapshot: (path: string) => Promise<FileSnapshot | undefined>;
    /** Reject symlinks and special files rather than following them. */
    stat: (
        path: string
    ) => Promise<{ kind: "file" | "directory"; size: number } | undefined>;
    /** Includes directories. */
    exists: (path: string) => Promise<boolean>;
    /** Recursive, idempotent directory creation. */
    createDirectory: (path: string) => Promise<void>;
    /** Create a file exclusively; never overwrite a raced destination.
     * Writes apply optional editor cursor metadata. No durability guarantee. */
    write: (path: string, snapshot: FileSnapshot) => Promise<void>;
    /** Move a file without replacing an existing destination. */
    rename: (from: string, to: string) => Promise<void>;
    /** Idempotently unlink one regular file. */
    deleteFile: (path: string) => Promise<void>;
    /** Prune directories using rmdir only. Reject files and nonempty directories. */
    delete: (path: string) => Promise<void>;
}
