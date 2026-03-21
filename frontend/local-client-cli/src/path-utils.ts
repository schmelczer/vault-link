import * as path from "path";

/**
 * Convert a native platform path to forward slashes.
 * On non-Windows platforms this is a no-op.
 */
export function toUnixPath(nativePath: string): string {
    if (path.sep === "\\") {
        return nativePath.replace(/\\/g, "/");
    }
    return nativePath;
}

/**
 * Convert a forward-slash path to native platform path separators.
 * On non-Windows platforms this is a no-op.
 */
export function toNativePath(forwardSlashPath: string): string {
    if (path.sep === "\\") {
        return forwardSlashPath.replace(/\//g, "\\");
    }
    return forwardSlashPath;
}

function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a glob pattern into a RegExp for repeated matching.
 * Supports:
 * - `*` matches any characters within a single path segment
 * - `**` matches zero or more path segments
 * - `?` matches a single character (not `/`)
 * - `dir/**` matches the directory itself and all its contents
 * - combined with `*.ext` matches files with the extension at any depth
 */
export function compileGlobPattern(pattern: string): RegExp {
    // Trailing /** matches the directory itself and all its contents
    if (pattern.endsWith("/**")) {
        const prefix = escapeRegex(pattern.slice(0, -3));
        return new RegExp(`^${prefix}(/.*)?$`);
    }

    let result = "^";
    let i = 0;
    while (i < pattern.length) {
        const c = pattern[i];
        if (c === "*" && pattern[i + 1] === "*") {
            if (pattern[i + 2] === "/") {
                // **/ matches zero or more directory segments
                result += "(?:.+/)?";
                i += 3;
            } else {
                result += ".*";
                i += 2;
            }
        } else if (c === "*") {
            result += "[^/]*";
            i++;
        } else if (c === "?") {
            result += "[^/]";
            i++;
        } else if (".+^${}()|[]\\".includes(c)) {
            result += "\\" + c;
            i++;
        } else {
            result += c;
            i++;
        }
    }
    result += "$";
    return new RegExp(result);
}
