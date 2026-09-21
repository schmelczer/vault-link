export const INTERNAL_DIRECTORY = ".vault-link-sync";
const MAX_COMPONENT_BYTES = 255;
const byteLength = (value: string): number =>
    new TextEncoder().encode(value).length;
function truncate(value: string, limit: number): string {
    let result = "";
    for (const character of value) {
        if (byteLength(result + character) > limit) break;
        result += character;
    }
    return result;
}

const reservedDeviceName =
    /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u;

// NFC -> uppercase -> NFC matches the server's locale-independent alias rules.
const pathKey = (path: string): string =>
    path.normalize("NFC").toUpperCase().normalize("NFC");

export const arePathAliases = (left: string, right: string): boolean =>
    pathKey(left) === pathKey(right);

export function findPathWithSameSpelling(
    paths: Iterable<string>,
    wanted: string
): string | undefined {
    const normalized = wanted.normalize("NFC");
    for (const path of paths) {
        if (path !== wanted && path.normalize("NFC") === normalized)
            return path;
    }
    return undefined;
}

export const isInternalPath = (path: string): boolean =>
    arePathAliases(path.split("/")[0], INTERNAL_DIRECTORY);

function validatePath(path: string): void {
    if (!path || path !== path.normalize("NFC") || isInternalPath(path))
        throw new Error(`Invalid portable path: ${path}`);

    for (const part of path.split("/")) {
        if (
            !part ||
            part === "." ||
            part === ".." ||
            /[<>:"\\|?*\p{Cc}]|[. ]$/u.test(part) ||
            reservedDeviceName.test(
                part.split(".")[0].replace(/ +$/u, "").toUpperCase()
            )
        )
            throw new Error(`Invalid portable path: ${path}`);
    }
}

export function validatePortablePaths(paths: Iterable<string>): void {
    // Component keys keep storage proportional to the input, even when a
    // manifest contains thousands of directory levels.
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
            const key = `${parent}/${pathKey(spelling)}`;
            const previous = nodes.get(key);
            if (
                previous &&
                (previous.spelling !== spelling || previous.file || file)
            )
                throw new Error(`Conflicting path: ${path}`);
            const node = previous ?? { id: nodes.size + 1, spelling, file };
            nodes.set(key, node);
            parent = node.id;
        });
    }
}

function portableName(part: string): string {
    let result = part
        .normalize("NFC")
        .replace(/[<>:"\\|?*\p{Cc}]/gu, "_")
        .replace(/[. ]+$/u, "_");
    if (!result || result === "." || result === "..") result = "_";
    if (
        reservedDeviceName.test(
            result.split(".")[0].replace(/ +$/u, "").toUpperCase()
        )
    )
        result = "_" + result;
    return result;
}

function fitName(name: string, suffix: string, file: boolean): string {
    const dot = file ? name.lastIndexOf(".") : -1;
    const extension = dot > 0 ? truncate(name.slice(dot), 64) : "";
    const stem = dot > 0 ? name.slice(0, dot) : name;
    return portableName(
        truncate(stem, MAX_COMPONENT_BYTES - byteLength(suffix + extension)) +
            suffix +
            extension
    );
}

function pathsConflict(left: string, right: string): boolean {
    const a = left.split("/"),
        b = right.split("/");
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        if (!arePathAliases(a[i], b[i])) return false;
        if (a[i] !== b[i]) return true;
    }
    return true; // Equal names, or a file occupies an ancestor directory.
}

function isAvailablePath(
    candidate: string,
    id: string,
    occupied: Readonly<Record<string, string>>
): boolean {
    validatePath(candidate);
    return Object.entries(occupied).every(
        ([otherId, path]) => otherId === id || !pathsConflict(candidate, path)
    );
}

/** Deterministic allocation also handles a file blocking an ancestor directory. */
export function allocatePortablePath(
    wanted: string,
    id: string,
    occupied: Readonly<Record<string, string>>
): string {
    id = portableName(truncate(id, 64));
    const originals = wanted.split("/");
    const parts = originals.map((part, index) => {
        const portable = portableName(part);
        return byteLength(portable) > MAX_COMPONENT_BYTES
            ? fitName(
                  portable,
                  ` (conflict ${id})`,
                  index === originals.length - 1
              )
            : portable;
    });
    if (isInternalPath(parts.join("/"))) parts[0] = "_" + parts[0];
    let candidate = parts.join("/");
    const suffix = ` (conflict ${id})`;
    const limit = (Object.keys(occupied).length + 1) * (parts.length + 1);
    for (let attempt = 0; attempt <= limit; attempt++) {
        try {
            if (isAvailablePath(candidate, id, occupied)) return candidate;
        } catch {
            /* allocate below */
        }
        const current = candidate.split("/");
        let conflictAt = current.length - 1;
        for (let i = 0; i < current.length; i++) {
            const prefix = current.slice(0, i + 1).join("/");
            if (
                Object.values(occupied).some((path) => {
                    const other = path
                        .split("/")
                        .slice(0, i + 1)
                        .join("/");
                    return (
                        arePathAliases(prefix, other) &&
                        (prefix !== other ||
                            path.split("/").length === i + 1 ||
                            i === current.length - 1)
                    );
                })
            ) {
                conflictAt = i;
                break;
            }
        }
        const original = parts[conflictAt] ?? current[conflictAt];
        current[conflictAt] = fitName(
            original,
            suffix + (attempt ? ` (${attempt})` : ""),
            conflictAt === current.length - 1
        );
        candidate = current.join("/");
    }
    throw new Error(`Unable to allocate a portable path: ${wanted}`);
}
