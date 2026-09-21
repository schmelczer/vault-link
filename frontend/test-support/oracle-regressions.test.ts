import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { StoredDatabase } from "sync-client";
import { assertCanonical } from "./canonical";
import { assertManifest } from "./oracles";
import { NetworkFaults } from "./network";
import { MemoryDisk } from "./storage";
import { DeterministicAgent } from "../deterministic-tests/src/deterministic-agent";
import { AssertableState } from "../deterministic-tests/src/utils/assertable-state";
import type { ExpectedDocument } from "../deterministic-tests/src/test-definition";

const bytes = (text: string) => new TextEncoder().encode(text);
const id = "00000000-0000-4000-8000-000000000001";

test("canonical checks reject repeated clients before reading snapshots", async () => {
    const client = { files: () => new Map(), database: () => ({}) };
    await assert.rejects(
        assertCanonical([client, client], "http://unused", "unused"),
        /itself/
    );
});

test("canonical checks independently verify both persisted content hashes", async (context) => {
    const content = bytes("\ufeffexact bytes\r\n");
    const hash = createHash("sha256").update(content).digest("hex");
    const document = {
        documentId: id,
        vaultUpdateId: 1,
        contentSize: content.length,
        userId: "user",
        deviceId: "device",
        updatedDate: "2026-09-20T00:00:00Z"
    };
    const manifest = { fileManifestId: 2, entries: { [id]: "a.md" } };
    const state: Partial<StoredDatabase> = {
        initialized: true,
        local: manifest.entries,
        fileManifest: manifest,
        lastSeenUpdateId: 2,
        documents: {
            [id]: {
                materialized: true,
                observedHash: hash,
                base: { ...document, hash }
            }
        }
    };
    context.mock.method(
        globalThis,
        "fetch",
        async (url: string) =>
            new Response(
                JSON.stringify(
                    url.endsWith("/vault-snapshot")
                        ? {
                              headEventId: 2,
                              fileManifest: manifest,
                              documents: [document]
                          }
                        : url.includes("/events-since")
                          ? {
                                headEventId: 2,
                                events: [
                                    { eventId: 1, requestId: "create" },
                                    { eventId: 2, requestId: "manifest" }
                                ]
                            }
                          : {
                                contentBase64:
                                    Buffer.from(content).toString("base64")
                            }
                )
            )
    );
    const client = (database = state) => ({
        files: () => new Map([["a.md", content.slice()]]),
        database: () => structuredClone(database)
    });
    await assertCanonical([client(), client()], "http://test", "token");
    for (const field of ["base", "observed"] as const) {
        const corrupt = structuredClone(state);
        if (field === "base") corrupt.documents![id].base!.hash = "wrong";
        else corrupt.documents![id].observedHash = "wrong";
        await assert.rejects(
            assertCanonical(
                [client(), client(corrupt)],
                "http://test",
                "token"
            ),
            new RegExp(`Wrong ${field} hash`)
        );
    }
});

test("lost responses require an identical retry, including request identity and target", async () => {
    for (const point of ["before", "after"] as const) {
        const faults = new NetworkFaults();
        let sent = 0;
        const send = faults.wrap(async () => {
            sent++;
            return new Response('{"type":"Accepted"}');
        });
        const url = "http://test/documents/a";
        const body = {
            requestId: "original",
            parentVersionId: 3,
            content: { type: "Snapshot", value: "YQ==" }
        };
        const init = { method: "PUT", body: JSON.stringify(body) };
        faults.arm("content", point);
        await assert.rejects(send(url, init), /Injected/);
        assert.throws(() => faults.assertConsumed(), /never retried/);
        assert.throws(
            () => faults.arm("manifest"),
            /not exercised and retried/
        );
        const before = sent;
        await assert.rejects(
            send(url, {
                ...init,
                body: JSON.stringify({ ...body, requestId: "regenerated" })
            }),
            /Retry changed/
        );
        await assert.rejects(
            send(`${url}-different`, init),
            /Retry changed target/
        );
        await assert.rejects(
            send(url, {
                ...init,
                body: JSON.stringify({ ...body, parentVersionId: 4 })
            }),
            /Retry changed/
        );
        assert.equal(sent, before, "Invalid retries must not reach the server");
        assert.throws(() => faults.assertConsumed(), /never retried/);
        await send(url, init);
        faults.assertConsumed();
    }
});

test("an update fault cannot be consumed by creating a new UUID", async () => {
    const faults = new NetworkFaults();
    const send = faults.wrap(async () => new Response('{"type":"Accepted"}'));
    faults.arm("content");
    await send("http://test/documents/new", {
        method: "PUT",
        body: '{"requestId":"new","parentVersionId":null}'
    });
    assert.throws(() => faults.assertConsumed(), /never fired/);
    const update = {
        method: "PUT",
        body: '{"requestId":"update","parentVersionId":1}'
    };
    await assert.rejects(
        send("http://test/documents/existing", update),
        /Injected/
    );
    await send("http://test/documents/existing", update);
    faults.assertConsumed();
});

test("unlink is idempotent even after an uncertain visible deletion", async () => {
    const disk = new MemoryDisk();
    await disk.userWrite("a", bytes("A"));
    disk.boundary = (label) => {
        if (label === "visible:unlink:a") throw new Error("uncertain unlink");
    };
    await assert.rejects(disk.deleteFile("a"), /uncertain/);
    disk.boundary = () => {};
    await disk.deleteFile("a");
    disk.crash(true);
    assert.equal(await disk.exists("a"), false);
    await disk.deleteFile("a");
    await disk.createDirectory("directory");
    await assert.rejects(disk.deleteFile("directory"), /directory/);
});

test("text assertions preserve BOM, CRLF, empty content and missing final newline", async () => {
    const agent = new DeterministicAgent(0, {}, () => {});
    for (const content of [
        "",
        "\ufeffhello",
        "\ufeffa\r\nb\r\n",
        "last line"
    ]) {
        await agent.disk.userWrite("a.md", bytes(content));
        assert.equal(await agent.getFileContent("a.md"), content);
    }
});

test("durably pruning a directory also removes its already-unlinked durable children", async () => {
    const disk = new MemoryDisk();
    await disk.userWrite("transaction/source", bytes("staged bytes"));
    disk.boundary = (label) => {
        if (label === "visible:unlink:transaction/source") {
            disk.crash(false);
            throw new Error("process died after unlink");
        }
    };
    await assert.rejects(disk.deleteFile("transaction/source"), /process died/);
    disk.boundary = () => {};
    await disk.delete("transaction");
    disk.crash(true);
    assert.deepEqual(disk.userFiles(), new Map());
    assert.equal(await disk.exists("transaction"), false);
});

test("portable components are limited by UTF-8 bytes, not characters or total path length", () => {
    for (const component of ["a".repeat(255), "é".repeat(127) + "a"])
        assertManifest({ [id]: `${component}/${component}/${component}` });
    for (const component of ["a".repeat(256), "é".repeat(128)])
        assert.throws(
            () => assertManifest({ [id]: `nested/${component}` }),
            /Oversized component/
        );
});

function state(documents: { path: string; content: string; id: string }[]) {
    return new AssertableState({
        files: new Map(documents.map((doc) => [doc.path, doc.content])),
        clientFiles: [],
        manifests: [],
        canonical: Object.fromEntries(
            documents.map((doc) => [doc.id, doc.path])
        ),
        bytes: new Map(documents.map((doc) => [doc.path, bytes(doc.content)]))
    });
}

test("complete scenario assertions reject collapsed creates, forgotten edits, reverted moves and recycled UUIDs", () => {
    const identities = new Map<string, string>();
    const expected: ExpectedDocument[] = [
        { key: "a", path: "a.md", content: "A\nimportant edit" },
        { key: "b", path: "b.md", content: "B" }
    ];
    const original = [
        { id: "id-a", path: "a.md", content: "A\nimportant edit" },
        { id: "id-b", path: "b.md", content: "B" }
    ];
    state(original).assertDocuments(expected, identities);
    assert.throws(
        () =>
            state([
                { ...original[0], content: "A\nimportant edit\nB" }
            ]).assertDocuments(expected, identities),
        /Expected 2 file/
    );
    assert.throws(
        () =>
            state([
                { ...original[0], content: "A" },
                original[1]
            ]).assertDocuments(expected, identities),
        /Byte mismatch/
    );
    const moved = [
        { ...expected[0], path: "b.md" },
        { ...expected[1], path: "a.md" }
    ];
    assert.throws(
        () => state(original).assertDocuments(moved, identities),
        /Byte mismatch/
    );
    assert.throws(
        () =>
            state([
                { ...original[0], id: "id-b" },
                { ...original[1], id: "id-a" }
            ]).assertDocuments(expected, identities),
        /identity changed/
    );
    state([original[1]]).assertDocuments([expected[1]], identities);
    assert.throws(
        () =>
            state(original).assertDocuments(
                [{ ...expected[0], key: "recreated" }, expected[1]],
                identities
            ),
        /reused.*deleted UUID/
    );
    assert.equal(identities.has("recreated"), false);
    const conflict = [
        { key: "one", path: "same.md", content: "one" },
        { key: "two", path: "same.md", conflict: true, content: "two" }
    ];
    state([
        { id: "one", path: "same.md", content: "one" },
        { id: "two", path: "same (conflict two).md", content: "two" }
    ]).assertDocuments(conflict, new Map());
});

test("canonical checks follow pages without weakening gap or duplicate-request detection", async (context) => {
    const manifest = { fileManifestId: 3, entries: {} };
    const client = () => ({
        files: () => new Map<string, Uint8Array>(),
        database: () => ({
            initialized: true,
            local: {},
            documents: {},
            fileManifest: manifest,
            lastSeenUpdateId: 3
        })
    });
    let fault = "none";
    context.mock.method(globalThis, "fetch", async (input: string) => {
        if (input.endsWith("/vault-snapshot"))
            return Response.json({
                headEventId: 3,
                fileManifest: manifest,
                documents: []
            });
        const after = Number(new URL(input).searchParams.get("after"));
        if (after === 0)
            return Response.json({
                headEventId: 3,
                endEventId: 1,
                events: [{ eventId: 1, requestId: "first" }]
            });
        assert.equal(after, 1);
        return Response.json({
            headEventId: 3,
            endEventId: fault === "empty" ? 1 : 3,
            events:
                fault === "empty"
                    ? []
                    : [
                          ...(fault === "gap"
                              ? []
                              : [
                                    {
                                        eventId: 2,
                                        requestId:
                                            fault === "duplicate"
                                                ? "first"
                                                : "second"
                                    }
                                ]),
                          { eventId: 3, requestId: "third" }
                      ]
        });
    });
    await assertCanonical([client(), client()], "http://test", "token");
    for (fault of ["gap", "duplicate", "empty"])
        await assert.rejects(
            assertCanonical([client(), client()], "http://test", "token"),
            /contiguous|multiple events|progress/
        );
});
