import type { RelativePath } from "../persistence/database";

/**
 * Validates that a relative path is safe and cannot escape the vault root.
 *
 * Rejects paths that:
 * - Are empty
 * - Start with `/` or `\` (absolute paths)
 * - Contain `..` path components (directory traversal)
 * - Contain null bytes (path truncation attacks)
 * - Contain backslash separators (Windows path injection)
 *
 * @throws {Error} if the path is unsafe
 */
export function validateRelativePath(path: RelativePath): void {
    if (path.length === 0) {
        throw new Error("Path must not be empty");
    }

    if (path.includes("\0")) {
        throw new Error(
            `Path contains null byte, which is not allowed: '${path}'`
        );
    }

    if (path.startsWith("/") || path.startsWith("\\")) {
        throw new Error(
            `Path must be relative, not absolute: '${path}'`
        );
    }

    if (path.includes("\\")) {
        throw new Error(
            `Path must use forward slashes, not backslashes: '${path}'`
        );
    }

    const components = path.split("/");
    for (const component of components) {
        if (component === "..") {
            throw new Error(
                `Path must not contain '..' components: '${path}'`
            );
        }
    }
}
