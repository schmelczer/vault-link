import { v4 as uuid } from "uuid";
import type { EngineState } from "../persistence/database";
import type { VaultSnapshot } from "../services/types/VaultSnapshot";
import { arePathAliases } from "../utils/portable-path";

export type LocalChange = {
    changeId?: string;
    /** Identities at notification time, before a remote application can reuse paths. */
    identities?: Record<string, string>;
} & (
    | { type: "move"; oldPath: string; relativePath: string }
    | { type: "create"; path: string; documentId?: string }
    | { type: "delete"; path: string }
);

export function unappliedChanges<T extends { changeId?: string }>(
    state: EngineState,
    changes: readonly T[]
): T[] {
    for (const change of changes) change.changeId ??= uuid();
    const applied = changes.findIndex(
        (change) => change.changeId === state.lastAppliedLocalChangeId
    );
    return changes.slice(applied + 1);
}

export function applyLocalChange(
    next: EngineState,
    change: LocalChange,
    ignored: (path: string) => boolean,
    initial?: VaultSnapshot
): void {
    if (change.type === "create") {
        if (
            ignored(change.path) ||
            Object.values(next.local).includes(change.path)
        )
            return;
        const id = (change.documentId ??=
            (initial &&
                Object.keys(initial.fileManifest.entries).find(
                    (id) =>
                        !next.local[id] &&
                        arePathAliases(
                            initial.fileManifest.entries[id],
                            change.path
                        )
                )) ||
            uuid());
        next.local[id] = change.path;
        next.documents[id] ??= {
            materialized: true,
            bootstrap: initial?.fileManifest.entries[id] !== undefined
        };
        return;
    }
    const from = change.type === "move" ? change.oldPath : change.path;
    change.identities ??= Object.fromEntries(
        Object.entries(next.local).filter(
            ([id, path]) =>
                next.documents[id]?.materialized &&
                (path === from || path.startsWith(from + "/"))
        )
    );
    for (const [id, path] of Object.entries(change.identities)) {
        if (change.type === "delete") {
            if (ignored(path)) {
                next.excluded ??= {};
                if (next.excluded[id] === undefined)
                    next.excluded[id] = next.fileManifest.entries[id] ?? null;
            }
            delete next.local[id];
        } else {
            const to = change.relativePath + path.slice(from.length);
            for (const [other, otherPath] of Object.entries(next.local))
                if (other !== id && otherPath === to) delete next.local[other];
            next.local[id] = to;
        }
    }
}
