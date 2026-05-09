import * as path from "path";

// Convert a native platform path to forward slashes (no-op on non-Windows)
export function toUnixPath(nativePath: string): string {
    return nativePath.split(path.sep).join(path.posix.sep);
}

// Match a file path against a glob pattern.
//
// Behaves like Node's path.matchesGlob with one extension: `dir/**` matches
// the directory `dir` itself, not only its descendants. The watcher feeds us
// a directory's relative path (e.g. ".git") at the same time it's about to
// recurse into it, and the natural way for users to write the ignore pattern
// is `.git/**` — under stdlib semantics that pattern would let the directory
// through and only block its children, defeating the prune.
export function matchesGlob(filePath: string, pattern: string): boolean {
    if (pattern.endsWith("/**") && filePath === pattern.slice(0, -3)) {
        return true;
    }
    return path.matchesGlob(filePath, pattern);
}
