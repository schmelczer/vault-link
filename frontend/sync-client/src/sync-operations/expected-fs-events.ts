import type { RelativePath } from "./types";

/**
 * Counter-based registry of filesystem events the syncer is about to
 * cause. The syncer's own writes/renames/deletes go through
 * `FileOperations`, which calls into the host filesystem; the host then
 * fires watcher events that come back through `SyncClient.syncLocallyXxx`.
 * Without filtering, those echo events would be re-uploaded to the server
 * and broadcast back, producing an unbounded loop.
 *
 * The fix: every fs call in `FileOperations` registers the event it is
 * about to provoke; the matching `syncLocallyXxx` handler consumes it.
 * User-initiated edits never register, so they pass through unchanged.
 *
 * Counts are per (kind, path) so back-to-back syncer ops on the same path
 * (e.g. apply remote update then re-apply during convergence) match
 * one-for-one. If the watcher never fires for a registered op (e.g. the
 * fs throws before notifying), the entry is left behind; `clear()` is
 * called on pause/destroy to drop those before they collide with a real
 * user event later.
 */
export class ExpectedFsEvents {
    private readonly creates = new Map<RelativePath, number>();
    private readonly updates = new Map<RelativePath, number>();
    private readonly deletes = new Map<RelativePath, number>();
    // Renames are keyed by `JSON.stringify({oldPath, newPath})` so the
    // delimiter cannot occur inside either path.
    private readonly renames = new Map<RelativePath, number>();

    public expectCreate(path: RelativePath): void {
        this.bump(this.creates, path);
    }

    public expectUpdate(path: RelativePath): void {
        this.bump(this.updates, path);
    }

    public expectDelete(path: RelativePath): void {
        this.bump(this.deletes, path);
    }

    public expectRename(
        oldPath: RelativePath,
        newPath: RelativePath
    ): void {
        this.bump(this.renames, ExpectedFsEvents.renameKey(oldPath, newPath));
    }

    public matchCreate(path: RelativePath): boolean {
        return this.consume(this.creates, path);
    }

    public matchUpdate(
        path: RelativePath,
        oldPath: RelativePath | undefined
    ): boolean {
        if (oldPath !== undefined) {
            return this.consume(
                this.renames,
                ExpectedFsEvents.renameKey(oldPath, path)
            );
        }
        return this.consume(this.updates, path);
    }

    public matchDelete(path: RelativePath): boolean {
        return this.consume(this.deletes, path);
    }

    public clear(): void {
        this.creates.clear();
        this.updates.clear();
        this.deletes.clear();
        this.renames.clear();
    }

    private static renameKey(
        oldPath: RelativePath,
        newPath: RelativePath
    ): string {
        return JSON.stringify({ oldPath, newPath });
    }

    private bump(map: Map<RelativePath, number>, key: RelativePath): void {
        map.set(key, (map.get(key) ?? 0) + 1);
    }

    private consume(
        map: Map<RelativePath, number>,
        key: RelativePath
    ): boolean {
        const count = map.get(key) ?? 0;
        if (count === 0) return false;
        if (count === 1) map.delete(key);
        else map.set(key, count - 1);
        return true;
    }
}
