import type { DocumentId, RelativePath } from "../persistence/database";

export const INTERNAL_DIRECTORY = ".vault-link-sync";
const MAX_COMPONENT_BYTES = 255;


const reservedDeviceName =
    /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u;



export const arePathAliases = (
    left: RelativePath,
    right: RelativePath
): boolean => getPathKey(left) === getPathKey(right);

// NFC -> uppercase -> NFC matches the server's locale-independent alias rules.
const getPathKey = (path: RelativePath): string =>
    path.normalize("NFC").toUpperCase().normalize("NFC");

export function findPathWithSameSpelling(
    paths: Iterable<RelativePath>,
    wanted: RelativePath
): RelativePath | undefined {
    const normalized = wanted.normalize("NFC");
    for (const path of paths) {
        if (path !== wanted && path.normalize("NFC") === normalized) {
            return path;
        }
    }

    return undefined;
}

export const isInternalPath = (path: RelativePath): boolean =>
    arePathAliases(path.split("/")[0] ?? "", INTERNAL_DIRECTORY);

function validatePath(path: RelativePath): void {
    if (!path || path !== path.normalize("NFC") || isInternalPath(path)) {
        throw new Error(`Invalid portable path: ${path}`);
    }

    for (const part of path.split("/")) {
        if (
            !part ||
            part === "." ||
            part === ".." ||
            /[<>:"\\|?*\p{Cc}]|[. ]$/u.test(part) ||
            reservedDeviceName.test(
                (part.split(".")[0] ?? "").replace(/ +$/u, "").toUpperCase()
            )
        ) {
            throw new Error(`Invalid portable path: ${path}`);
        }
    }
}

export function validatePortablePaths(paths: Iterable<RelativePath>): void {
    const nodes = new Map<
        string,
        { id: number; spelling: string; file: boolean }
    >();
    for (const path of paths) {
        validatePath(path);

        const parts = path.split("/");
        let parent = 0;

        parts.forEach((spelling, index) => {
            const file = index === parts.length - 1;
            const key = `${parent}/${getPathKey(spelling)}`;
            const previous = nodes.get(key);
            if (
                previous &&
                (previous.spelling !== spelling || previous.file || file)
            ) {
                throw new Error(`Conflicting path: ${path}`);
            }

            const node = previous ?? { id: nodes.size + 1, spelling, file };
            nodes.set(key, node);
            parent = node.id;
        });
    }
}



/** First aliased component, or the file occupying a shared path prefix. */
function findConflictIndex(
    left: readonly string[],
    right: readonly string[]
): number | undefined {
    const shared = Math.min(left.length, right.length);
    for (let i = 0; i < shared; i++) {
        if (!arePathAliases(left[i] ?? "", right[i] ?? "")) {
            return;
        }

        if (left[i] !== right[i]) {
            return i;
        }
    }

    return shared - 1;
}

/** Deterministic allocation also handles a file blocking an ancestor directory. */
export function allocatePortablePath(
    wanted: RelativePath,
    id: DocumentId,
    occupied: readonly RelativePath[]
): RelativePath {
    id = sanitizeFileName(truncateToByteLength(id, 64));

    const originals = wanted.split("/");
    const parts = originals.map((part, index) => {
        const portable = sanitizeFileName(part);

        return getByteLength(portable) > MAX_COMPONENT_BYTES
            ? fitName(
                portable,
                ` (conflict ${id})`,
                index === originals.length - 1
            )
            : portable;
    });

    if (isInternalPath(parts.join("/"))) {
        parts[0] = "_" + parts[0];
    }

    const current = [...parts];
    const occupiedParts = occupied.map((path) => path.split("/"));
    const suffix = ` (conflict ${id})`;
    const limit = (occupied.length + 1) * (parts.length + 1);

    for (let attempt = 0; attempt <= limit; attempt++) {
        let conflictAt: number | undefined = undefined;
        for (const other of occupiedParts) {
            const index = findConflictIndex(current, other);

            if (
                index !== undefined &&
                (conflictAt === undefined || index < conflictAt)
            ) {
                conflictAt = index;
            }
        }

        if (conflictAt === undefined) {
            return current.join("/");
        }

        current[conflictAt] = fitName(
            parts[conflictAt] ?? "",
            suffix + (attempt ? ` (${attempt})` : ""),
            conflictAt === current.length - 1
        );
    }

    throw new Error(`Unable to allocate a portable path: ${wanted}`);
}

function sanitizeFileName(part: string): string {
    let result = part
        .normalize("NFC")
        .replace(/[<>:"\\|?*\p{Cc}]/gu, "_")
        .replace(/[. ]+$/u, "_");
    if (!result || result === "." || result === "..") {
        result = "_";
    }

    if (
        reservedDeviceName.test(
            (result.split(".")[0] ?? "").replace(/ +$/u, "").toUpperCase()
        )
    ) {
        result = "_" + result;
    }

    return result;
}

function fitName(name: string, suffix: string, file: boolean): string {
    const dot = file ? name.lastIndexOf(".") : -1;
    const extension = dot > 0 ? truncateToByteLength(name.slice(dot), 64) : "";
    const stem = dot > 0 ? name.slice(0, dot) : name;

    return sanitizeFileName(
        truncateToByteLength(
            stem,
            MAX_COMPONENT_BYTES - getByteLength(suffix + extension)
        ) +
        suffix +
        extension
    );
}

function truncateToByteLength(value: string, limit: number): string {
    let result = "";
    for (const character of value) {
        if (getByteLength(result + character) > limit) {
            break;
        }

        result += character;
    }

    return result;
}


const getByteLength = (value: string): number =>
    new TextEncoder().encode(value).length;
