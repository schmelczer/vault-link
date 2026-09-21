import assert from "node:assert/strict";
import type { StoredDatabase } from "sync-client";

export function assertSameFiles(
    clients: readonly Map<string, Uint8Array>[]
): void {
    assert(
        clients.length >= 2,
        "Consistency requires at least two distinct clients"
    );
    assert.equal(
        new Set(clients).size,
        clients.length,
        "Cannot compare a client to itself"
    );
    const sorted = (files: Map<string, Uint8Array>) =>
        [...files].sort(([a], [b]) => a.localeCompare(b));
    for (let i = 1; i < clients.length; i++)
        assert.deepEqual(
            sorted(clients[i]),
            sorted(clients[0]),
            `Client ${i} differs from client 0 (paths or bytes)`
        );
}

export function assertManifest(entries: Record<string, string>): void {
    const paths = Object.values(entries);
    const folded = paths.map((p) =>
        p.normalize("NFC").toUpperCase().normalize("NFC")
    );
    const directorySpellings = new Map<string, string>();
    for (const path of paths) {
        assert.equal(
            path,
            path.normalize("NFC"),
            `Noncanonical Unicode path: ${path}`
        );
        const parts = path.split("/");
        parts.forEach((part, i) => {
            assert(
                Buffer.byteLength(part, "utf8") <= 255,
                `Oversized component: ${part}`
            );
            assert(
                !/[<>:"\\|?*\p{Cc}]|[. ]$/u.test(part),
                `Nonportable component: ${part}`
            );
            assert(
                !/^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(
                    part.split(".")[0].trimEnd().toUpperCase()
                ),
                `Reserved component: ${part}`
            );
            if (i < parts.length - 1) {
                const prefix = parts.slice(0, i + 1).join("/");
                const key = prefix.toUpperCase().normalize("NFC");
                const previous = directorySpellings.get(key);
                assert(
                    previous === undefined || previous === prefix,
                    `Aliased directory spellings: ${prefix} and ${previous}`
                );
                directorySpellings.set(key, prefix);
            }
        });
    }
    assert.equal(
        new Set(folded).size,
        paths.length,
        "Manifest contains aliased/duplicate paths"
    );
    for (const path of folded) {
        assert(
            path && !path.startsWith("/") && !path.includes("\\"),
            `Invalid path ${path}`
        );
        assert(
            path.split("/").every((p) => p && p !== "." && p !== ".."),
            `Invalid component ${path}`
        );
        assert(
            path.split("/")[0] !== ".VAULT-LINK-SYNC",
            "Internal path in manifest"
        );
        assert(
            !folded.some(
                (other) => other !== path && other.startsWith(`${path}/`)
            ),
            `File/ancestor conflict: ${path}`
        );
    }
}

/** Independent per-ID policy oracle, intentionally not importing merge code. */
export function pathDecision(
    base: string | undefined,
    local: string | undefined,
    remote: string | undefined
): string | undefined {
    if (local === base) return remote;
    if (remote === base) return local;
    return remote;
}

export function assertQuiescent(
    state: Partial<StoredDatabase>,
    entries: Record<string, string>,
    head: number
): void {
    assert.equal(
        state.pending,
        undefined,
        "Pending CAS request at convergence"
    );
    assert.equal(
        state.eventReplay,
        undefined,
        "Unfinished event replay at convergence"
    );
    assert.equal(
        state.application,
        undefined,
        "Unfinished filesystem journal at convergence"
    );
    assert.deepEqual(
        state.local,
        entries,
        "Local UUID/path map differs from server"
    );
    assert.deepEqual(
        state.fileManifest?.entries,
        entries,
        "Client manifest differs from server"
    );
    assert.equal(
        state.lastSeenUpdateId,
        head,
        "Client event watermark differs from server"
    );
    assertManifest(entries);
}

/** Removal exemptions name exact markers and the explicit destructive action.
 * Deletion mode never disables preservation for unrelated documents. */
export class ContentLedger {
    private readonly markers = new Map<string, string | undefined>();
    public add(marker: string): void {
        assert(!this.markers.has(marker), "Duplicate marker");
        this.markers.set(marker, undefined);
    }
    public removedBy(content: string, action: string): void {
        assert(action.length > 0);
        for (const marker of this.markers.keys())
            if (content.includes(marker)) this.markers.set(marker, action);
    }
    public assertPreserved(files: Map<string, Uint8Array>): void {
        const texts = [...files.values()].map((bytes) =>
            Buffer.from(bytes).toString("utf8")
        );
        for (const [marker, deletion] of this.markers) {
            const count = texts.reduce(
                (n, text) => n + text.split(marker).length - 1,
                0
            );
            assert(count <= 1, `Marker ${marker} duplicated ${count} times`);
            if (!deletion)
                assert.equal(
                    count,
                    1,
                    `Marker ${marker} lost without an explicit delete/overwrite`
                );
        }
    }
}
