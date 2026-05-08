import * as path from "path";

// Convert a native platform path to forward slashes (no-op on non-Windows)
export function toUnixPath(nativePath: string): string {
    return nativePath.split(path.sep).join(path.posix.sep);
}

// Match a file path against a glob pattern
// Extends path.matchesGlob so that "dir/**" also matches the directory itself
export function matchesGlob(filePath: string, pattern: string): boolean {
    if (pattern.endsWith("/**") && filePath === pattern.slice(0, -3)) {
        return true;
    }
    return path.matchesGlob(filePath, pattern);
}
