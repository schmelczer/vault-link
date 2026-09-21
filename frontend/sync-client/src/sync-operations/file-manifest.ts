import type { FileManifestEntries } from "../types/file-manifest-entries";
import {
    allocatePortablePath,
    validatePortablePaths
} from "../utils/portable-path";

export function validateFileManifest(entries: FileManifestEntries): void {
    validatePortablePaths(Object.values(entries));
}

export function sameFileManifest(
    a: FileManifestEntries,
    b: FileManifestEntries
): boolean {
    return (
        Object.keys(a).length === Object.keys(b).length &&
        Object.keys(a).every((id) => a[id] === b[id])
    );
}

export function resolvePaths(
    proposed: FileManifestEntries,
    remote: FileManifestEntries,
    protectedIds: readonly string[] = [],
    reservedPaths: readonly string[] = []
): FileManifestEntries {
    const result: FileManifestEntries = {};
    for (const id of protectedIds)
        if (proposed[id] !== undefined) result[id] = proposed[id];
    const occupied = { ...result };
    for (const [index, path] of reservedPaths.entries())
        if (!Object.values(result).includes(path))
            occupied[`reserved-${index}`] = path;
    const ids = Object.keys(proposed).sort(
        (a, b) =>
            Number(remote[b] === proposed[b]) -
                Number(remote[a] === proposed[a]) ||
            (a < b ? -1 : a > b ? 1 : 0)
    );
    for (const id of ids.filter(
        (candidate) => result[candidate] === undefined
    )) {
        result[id] = allocatePortablePath(proposed[id], id, occupied);
        occupied[id] = result[id];
    }
    return result;
}

export function mergeFileManifests(
    base: FileManifestEntries,
    local: FileManifestEntries,
    remote: FileManifestEntries
): FileManifestEntries {
    const proposed: FileManifestEntries = {};
    for (const id of new Set([
        ...Object.keys(base),
        ...Object.keys(local),
        ...Object.keys(remote)
    ])) {
        const path =
            local[id] === base[id]
                ? remote[id]
                : remote[id] === base[id]
                  ? local[id]
                  : remote[id];
        if (path !== undefined) proposed[id] = path;
    }
    return resolvePaths(proposed, remote);
}
