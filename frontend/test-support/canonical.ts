import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { StoredDatabase } from "sync-client";
import { assertQuiescent, assertSameFiles } from "./oracles";

export interface CanonicalSnapshot {
    headEventId: number;
    fileManifest: { fileManifestId: number; entries: Record<string, string> };
    documents: { documentId: string; vaultUpdateId: number }[];
}
export interface InspectableClient {
    files(): Map<string, Uint8Array>;
    database(): Partial<StoredDatabase> | undefined;
}

export async function getJson<T>(url: string, token: string): Promise<T> {
    const response = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            "Device-Id": "harness-observer"
        },
        signal: AbortSignal.timeout(5_000)
    });
    assert(response.ok, `Observer GET ${url}: HTTP ${response.status}`);
    return (await response.json()) as T;
}

/** Equality alone can pass when every replica loses the same bytes. Check the
 * canonical UUIDs, content heads, receipts and event cursor as well.
 * Scenario-specific content/identity oracles still run separately.
 */
export async function assertCanonical(
    clients: InspectableClient[],
    vaultUrl: string,
    token: string
): Promise<CanonicalSnapshot> {
    assert.equal(
        new Set(clients).size,
        clients.length,
        "Cannot compare a client to itself"
    );
    const files = clients.map((client) => client.files());
    const states = clients.map((client) => client.database());
    assertSameFiles(files);
    const snapshot = await getJson<CanonicalSnapshot>(
        `${vaultUrl}/vault-snapshot`,
        token
    );
    const entries = snapshot.fileManifest.entries;
    for (const id of Object.keys(entries))
        assert(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
                id
            ),
            `Non-UUID document identity: ${id}`
        );
    const heads = Object.fromEntries(
        snapshot.documents.map((doc) => [doc.documentId, doc])
    );
    assert.equal(
        Object.keys(heads).length,
        snapshot.documents.length,
        "Duplicate document heads"
    );
    assert.deepEqual(
        Object.keys(heads).sort(),
        Object.keys(entries).sort(),
        "Snapshot heads differ from membership"
    );
    for (const [i, state] of states.entries()) {
        assert(state?.initialized, `Client ${i} never initialized`);
        assertQuiescent(state, entries, snapshot.headEventId);
        assert.equal(
            state.fileManifest?.fileManifestId,
            snapshot.fileManifest.fileManifestId,
            "Wrong manifest CAS parent"
        );
        assert.deepEqual(
            [...files[i].keys()].sort(),
            Object.values(entries).sort(),
            "Untracked or missing disk files"
        );
        for (const id of Object.keys(entries)) {
            assert(
                state.documents?.[id]?.materialized,
                `Unmaterialized document: ${id}`
            );
            assert.equal(
                state.documents?.[id]?.base?.vaultUpdateId,
                heads[id]?.vaultUpdateId,
                `Wrong content CAS parent: ${id}`
            );
        }
    }
    for (const [id, path] of Object.entries(entries)) {
        const doc = await getJson<{ contentBase64: string }>(
            `${vaultUrl}/documents/${id}`,
            token
        );
        const serverBytes = new Uint8Array(
            Buffer.from(doc.contentBase64, "base64")
        );
        assert.deepEqual(
            files[0].get(path),
            serverBytes,
            `Server bytes differ for ${id} at ${path}`
        );
        const hash = createHash("sha256").update(serverBytes).digest("hex");
        for (const [i, state] of states.entries()) {
            assert.equal(
                state!.documents?.[id]?.base?.hash,
                hash,
                `Wrong base hash: client ${i}, ${id}`
            );
            assert.equal(
                state!.documents?.[id]?.observedHash,
                hash,
                `Wrong observed hash: client ${i}, ${id}`
            );
        }
    }
    const events: { eventId: number; requestId: string }[] = [];
    let after = 0;
    do {
        const batch = await getJson<{
            headEventId: number;
            endEventId?: number;
            events: { eventId: number; requestId: string }[];
        }>(`${vaultUrl}/events-since?after=${after}`, token);
        assert.equal(
            batch.headEventId,
            snapshot.headEventId,
            "Server changed while checking convergence"
        );
        const end = batch.endEventId ?? batch.headEventId;
        assert.equal(
            end,
            batch.events.at(-1)?.eventId ?? after,
            "Event page cursor differs from its contents"
        );
        if (after < snapshot.headEventId)
            assert(end > after, "Event page made no progress");
        events.push(...batch.events);
        after = end;
    } while (after < snapshot.headEventId);
    assert.deepEqual(
        events.map((e) => e.eventId),
        Array.from({ length: snapshot.headEventId }, (_, i) => i + 1),
        "Server event log is not contiguous and totally ordered"
    );
    assert.equal(
        new Set(events.map((e) => e.requestId)).size,
        events.length,
        "An idempotent request emitted multiple events"
    );
    return snapshot;
}
