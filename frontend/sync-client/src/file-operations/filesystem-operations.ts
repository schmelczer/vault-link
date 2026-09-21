import type { CursorPosition } from "reconcile-text";

export interface FileSnapshot {
    content: Uint8Array;
    /** Optional editor selections, moved with the file and applied with its bytes. */
    cursors?: CursorPosition[];
}

/** Required adapter contract for API v4; there is deliberately no weak fallback.
 * Paths are vault-relative. Never follow symlinks (including ancestor symlinks).
 * Only independent regular files are supported; reject hardlinks/special files.
 * Every mutation must flush file data and affected directories before resolving.
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
    /** Recursive, idempotent, durable directory creation. */
    createDirectory: (path: string) => Promise<void>;
    /** Atomically create a complete file: never replace an existing object.
     * A crash leaves the path absent or complete, never a partial file.
     * Flush data and directory entries before resolving. */
    write: (path: string, snapshot: FileSnapshot) => Promise<void>;
    /** Atomic, durable rename on the same filesystem; fail if destination exists.
     * Flush the source's data and both affected directories before resolving. */
    rename: (from: string, to: string) => Promise<void>;
    /** Flush existing files and all affected ancestor directories, even when a
     * named file is absent. Recovery uses this after a mutation became visible
     * before its caller learned that it was durable. */
    flushPaths: (paths: readonly string[]) => Promise<void>;
    /** Idempotently unlink one regular file and flush its parent directory.
     * The sync engine uses this only for its own internal recovery artifacts. */
    deleteFile: (path: string) => Promise<void>;
    /** Prune an implicit directory tree using rmdir only, durably. Reject
     * regular files and never unlink descendant files; reject if files remain.
     * Partial removal of empty child directories on failure is harmless. */
    delete: (path: string) => Promise<void>;
}
