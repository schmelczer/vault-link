import { v4 as uuid } from "uuid";
import type { FileOperations } from "../file-operations/file-operations";
import type { EngineState } from "../persistence/database";
import type { VaultSnapshot } from "../services/types/VaultSnapshot";
import { EMPTY_HASH, hash } from "../utils/hash";
import {
    arePathAliases,
    findPathWithSameSpelling
} from "../utils/portable-path";

import {
    applyLocalChange,
    unappliedChanges,
    type LocalChange
} from "./local-changes";
export type { LocalChange } from "./local-changes";

interface ScanOptions {
    next: EngineState;
    guard: () => void;
    changes: LocalChange[];
    files: FileOperations;
    ignored: (path: string) => boolean;
    oversized: (size: number) => boolean;
    commit: (next: EngineState) => Promise<void>;
}

/** Scans are complete or fail. Missing unmaterialized/ignored entries are not deletions. */
export async function scanLocalFiles(
    {
        next,
        guard,
        changes: queuedChanges,
        files,
        ignored,
        oversized,
        commit
    }: ScanOptions,
    initial?: VaultSnapshot
): Promise<Set<string>> {
    // Leave the prefix queued until its resulting state is saved.
    // A persisted change ID makes replay safe after an uncertain save.
    const changes = [...queuedChanges];
    const unsyncablePaths = new Set<string>();
    for (const change of unappliedChanges(next, changes)) {
        applyLocalChange(next, change, ignored, initial);
        next.lastAppliedLocalChangeId = change.changeId;
    }
    const paths: string[] = [];
    const reportedPaths = await files.listFilesRecursively();
    for (const path of reportedPaths) {
        // Some filesystems may report a different Unicode spelling after a
        // rename. Keep an already-accessible spelling when possible.
        const alias = findPathWithSameSpelling(Object.values(next.local), path);
        paths.push(
            alias &&
                !reportedPaths.includes(alias) &&
                (await files.fs.exists(alias))
                ? alias
                : path
        );
    }
    const present = new Set(paths);
    const snapshots = new Map<string, { hash: string }>();
    for (const path of paths) {
        if (ignored(path)) {
            unsyncablePaths.add(path);
            continue;
        }
        const info = await files.fs.stat(path);
        if (!info || info.kind !== "file")
            throw new Error(`File changed during scan: ${path}`);
        if (oversized(info.size)) {
            unsyncablePaths.add(path);
            continue;
        }
        const snapshot = await files.fs.readSnapshot(path);
        if (!snapshot) throw new Error(`File changed during scan: ${path}`);
        if (!oversized(snapshot.content.length)) {
            snapshots.set(path, { hash: await hash(snapshot.content) });
        } else {
            unsyncablePaths.add(path);
        }
    }
    const missing = new Set(
        Object.keys(next.local).filter(
            (id) =>
                next.documents[id]?.materialized &&
                !ignored(next.local[id]) &&
                !present.has(next.local[id])
        )
    );
    const knownPaths = new Set(Object.values(next.local));
    const unknown = [...snapshots.keys()].filter(
        (path) => !knownPaths.has(path)
    );
    for (const path of unknown) {
        const snapshot = snapshots.get(path)!;
        const matches = [...missing].filter(
            (id) => next.documents[id]?.observedHash === snapshot.hash
        );
        const sameHash = unknown.filter(
            (other) => snapshots.get(other)?.hash === snapshot.hash
        );
        let id: string | undefined;
        if (
            snapshot.hash !== EMPTY_HASH &&
            matches.length === 1 &&
            sameHash.length === 1
        ) {
            id = matches[0];
            missing.delete(id);
        } else if (initial) {
            id = Object.keys(initial.fileManifest.entries).find(
                (candidate) =>
                    !next.local[candidate] &&
                    arePathAliases(
                        initial.fileManifest.entries[candidate],
                        path
                    )
            );
        }
        id ??= uuid();
        next.local[id] = path;
        next.documents[id] ??= {
            materialized: true,
            bootstrap: initial?.fileManifest.entries[id] !== undefined
        };
    }
    for (const id of missing) delete next.local[id];
    for (const [id, path] of Object.entries(next.local)) {
        if (unsyncablePaths.has(path) || ignored(path)) {
            next.excluded ??= {};
            if (next.excluded[id] === undefined)
                next.excluded[id] = next.fileManifest.entries[id] ?? null;
        }
        const snapshot = snapshots.get(path);
        if (snapshot) {
            next.documents[id] ??= { materialized: true };
            if (!next.documents[id].materialized && !next.documents[id].base)
                next.documents[id].bootstrap = true;
            next.documents[id].materialized = true;
            next.documents[id].observedHash = snapshot.hash;
        }
    }
    next.protectedPaths = [...unsyncablePaths];
    guard();
    await commit(next);
    queuedChanges.splice(0, changes.length);
    guard();
    return unsyncablePaths;
}
