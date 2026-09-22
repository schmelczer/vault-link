import assert from "node:assert/strict";
import { PermanentSyncError } from "../sync-client/src/errors/errors";
import { test } from "node:test";
import { Database, emptyState } from "../sync-client/src/persistence/database";
import { Syncer } from "../sync-client/src/sync-operations/syncer";
import { SyncClient, type StoredClient } from "../sync-client/src/sync-client";
import { toStoredSnapshot } from "../sync-client/src/sync-operations/content";
import { allocatePortablePath } from "../sync-client/src/utils/portable-path";
import { MemoryDisk, MemoryPersistence } from "./storage";

import { bytes, head, fixture } from "./sync-fixture";

test("offline content notifications need no saves and restart reads the current bytes", async () => {
    const disk = new MemoryDisk();
    await disk.userWrite("a.md", bytes("original"));
    const initial = emptyState(JSON.stringify(["http://offline.test", "test"]));
    initial.initialized = true;
    initial.local = { a: "a.md" };
    initial.documents.a = {
        materialized: true,
        observedHash: (await toStoredSnapshot({ content: bytes("original") }))
            .hash
    };
    const store = new MemoryPersistence({
        database: initial,
        settings: { remoteUri: "http://offline.test", vaultName: "test" }
    });
    let client = await SyncClient.create({ fs: disk, persistence: store });
    try {
        const saved = store.snapshot();
        store.boundary = () => {
            throw new Error("content notifications must not save");
        };
        for (let edit = 0; edit < 20; edit++) {
            await disk.userWrite("a.md", bytes(`edit ${edit}`));
            await client.syncLocallyUpdatedFile({ relativePath: "a.md" });
        }
        await client.destroy();
        assert.deepEqual(store.snapshot(), saved);
        store.boundary = () => {};
        // A final edit has no notification at all.
        await disk.userWrite("a.md", bytes("latest offline bytes"));
        client = await SyncClient.create({ fs: disk, persistence: store });
        const internals = client as unknown as {
            database: Database;
            syncer: {
                stopped: boolean;
                scan(): Promise<void>;
                preparePush(): Promise<boolean>;
            };
        };
        await internals.syncer.scan();
        internals.syncer.stopped = false;
        assert.equal(await internals.syncer.preparePush(), true);
        const pending = internals.database.state.pending;
        assert(pending?.type === "content");
        assert.equal(pending.documentId, "a");
        assert.equal(
            Buffer.from(pending.snapshot.contentBase64, "base64").toString(),
            "latest offline bytes"
        );
    } finally {
        store.boundary = () => {};
        await client.destroy();
    }
});

test("legacy content notifications preserve the acknowledged namespace prefix on restart", async () => {
    const disk = new MemoryDisk();
    await disk.userWrite("d.md", bytes("A"));
    await disk.userWrite("b.md", bytes("B"));
    const initial = emptyState(JSON.stringify(["http://offline.test", "test"]));
    initial.initialized = true;
    initial.local = { a: "c.md", b: "b.md" };
    initial.fileManifest.entries = { ...initial.local };
    for (const [id, content] of [
        ["a", "A"],
        ["b", "B"]
    ])
        initial.documents[id] = {
            materialized: true,
            observedHash: (await toStoredSnapshot({ content: bytes(content) }))
                .hash
        };
    initial.lastAppliedLocalChangeId = "consumed-update";
    const saved: StoredClient = {
        database: initial,
        settings: { remoteUri: "http://offline.test", vaultName: "test" },
        localChangesVaultKey: initial.vaultKey,
        localChanges: [
            {
                type: "move",
                oldPath: "a.md",
                relativePath: "b.md",
                identities: { a: "a.md" },
                changeId: "consumed-move"
            },
            { type: "update", path: "c.md", changeId: "consumed-update" },
            { type: "update", path: "b.md", changeId: "new-update" },
            {
                type: "move",
                oldPath: "c.md",
                relativePath: "d.md",
                identities: { a: "c.md" },
                changeId: "new-move"
            }
        ]
    };
    const store = new MemoryPersistence(saved);
    const client = await SyncClient.create({ fs: disk, persistence: store });
    try {
        const internals = client as unknown as {
            database: Database;
            syncer: { scan(): Promise<void> };
        };
        await internals.syncer.scan();
        assert.deepEqual(internals.database.state.local, {
            a: "d.md",
            b: "b.md"
        });
        assert.equal(
            internals.database.state.lastAppliedLocalChangeId,
            "new-move"
        );
    } finally {
        await client.destroy();
    }
});

test("remote binary replacement and deletion do not create backup artifacts", async () => {
    const f = await fixture({ "a.bin": "private edit" });
    await f.files.apply(structuredClone(f.database.state), {
        a: { replacement: await toStoredSnapshot({ content: bytes("remote") }) }
    });
    assert.deepEqual(await f.disk.listFilesRecursively(), ["a.bin"]);
    assert.deepEqual(f.disk.userFiles(), new Map([["a.bin", bytes("remote")]]));
    await f.internals.incorporateFileManifest({
        fileManifestId: 2,
        entries: {}
    });
    assert.deepEqual(await f.disk.listFilesRecursively(), []);
});

test("rejected content recovery remains idempotent across a rename and network failure", async () => {
    let offline = true;
    const f = await fixture(undefined, {
        getDocumentVersionContent: async () => {
            if (offline) throw new Error("offline");
            return bytes("base");
        }
    });
    const snapshot = (await f.files.snapshot("a.md"))!;
    f.database.state.documents.a.base = {
        ...head("a", 1, "base"),
        hash: (await toStoredSnapshot({ content: bytes("base") })).hash
    };
    f.database.state.pending = {
        type: "content",
        documentId: "a",
        snapshot,
        request: {
            requestId: "request",
            parentVersionId: 1,
            content: { type: "Snapshot", value: snapshot.contentBase64 }
        },
        response: {
            type: "StaleBase",
            ...head("a", 2, "remote")
        }
    };
    await f.database.save();
    await f.disk.userRename("a.md", "renamed.md");
    await f.syncer.syncLocallyUpdatedFile({
        oldPath: "a.md",
        relativePath: "renamed.md"
    });
    await assert.rejects(f.internals.finishPending(), /offline/);
    offline = false;
    await f.internals.finishPending();
    assert.equal(f.database.state.pending, undefined);
    assert.equal(f.database.state.local.a, "renamed.md");
});

test("conflict names respect component limits without imposing a total path limit", () => {
    const wanted = "a".repeat(235) + ".md";
    const allocated = allocatePortablePath(
        wanted,
        "00000000-0000-4000-8000-000000000001",
        { other: wanted }
    );
    assert(Buffer.byteLength(allocated) <= 255);
    assert(allocated.endsWith(".md"));
    assert.notEqual(allocated, wanted);
    const longPath = "folder/".repeat(100) + "note.md";
    assert.equal(allocatePortablePath(longPath, "id", {}), longPath);
});

test("an unmaterialized file with a directory at its path is deconflicted", async () => {
    const f = await fixture(
        {},
        { getDocumentVersionContent: async () => bytes("remote") }
    );
    await f.disk.userWrite("folder/note.md", bytes("local"));
    f.database.state.local.a = "folder";
    f.database.state.documents.a = { materialized: false };
    f.database.state.fileManifest.entries.a = "folder";
    await f.database.save();
    await f.internals.incorporateContent(head("a", 2, "remote"));
    assert(
        [...f.disk.userFiles().values()].some(
            (value) => Buffer.from(value).toString() === "remote"
        )
    );
    assert(
        [...f.disk.userFiles().values()].some(
            (value) => Buffer.from(value).toString() === "local"
        )
    );
});

test("ignored materialized content survives remote deletion", async () => {
    const f = await fixture();
    await f.settings.setSettings({ ignorePatterns: ["a.md"] });
    await f.internals.incorporateFileManifest({
        fileManifestId: 2,
        entries: {}
    });
    assert.deepEqual(f.disk.userFiles(), new Map([["a.md", bytes("local")]]));
    assert.deepEqual(f.database.state.fileManifest.entries, {});
});

test("unfinished bootstrap cannot be rebound to another vault", async () => {
    const database = emptyState(JSON.stringify(["http://example.test", "old"]));
    database.bootstrap = {
        headEventId: 1,
        fileManifest: { fileManifestId: 1, entries: {} },
        documents: []
    };
    const persistence = new MemoryPersistence({
        settings: { remoteUri: "http://example.test", vaultName: "old" },
        database
    });
    const client = await SyncClient.create({
        fs: new MemoryDisk(),
        persistence
    });
    try {
        await assert.rejects(
            client.setSettings({ vaultName: "new" }),
            /separate state store/
        );
        assert.equal(persistence.snapshot().settings!.vaultName, "old");
    } finally {
        await client.destroy();
    }
});

test("a rejected upload is retained locally and does not block another file or a corrected snapshot", async () => {
    let reject = true;
    const sent: string[] = [];
    const f = await fixture(
        { "a.md": "too large", "b.md": "other" },
        {
            putFileContent: async (id) => {
                sent.push(id);
                if (id === "a" && reject)
                    throw new PermanentSyncError("HTTP 413");
                return {
                    type: "Accepted",
                    ...head(id, sent.length + 2, "small")
                };
            }
        }
    );
    f.internals.stopped = false;
    assert(await f.internals.preparePush());
    await f.internals.finishPending();
    assert.equal(f.database.state.pending, undefined);
    assert.match(f.database.state.documents.a.rejected!.message, /413/);
    assert(await f.internals.preparePush());
    await f.internals.finishPending();
    assert.deepEqual(sent, ["a", "b"]);
    assert.equal(await f.internals.preparePush(), false);
    await f.disk.userWrite("a.md", bytes("small"));
    reject = false;
    assert(await f.internals.preparePush());
    await f.internals.finishPending();
    assert.deepEqual(sent, ["a", "b", "a"]);
    assert.equal(f.database.state.documents.a.rejected, undefined);
});

test("a transient upload failure retries the exact request and recovers its acknowledgement", async () => {
    const requests: unknown[] = [];
    const f = await fixture(undefined, {
        putFileContent: async (_id, request) => {
            requests.push(structuredClone(request));
            if (requests.length === 1) throw new Error("lost upload reply");
            return { type: "Accepted", ...head("a", 2, "local") };
        }
    });
    f.internals.stopped = false;
    await f.internals.preparePush();
    await assert.rejects(f.internals.finishPending(), /lost upload reply/);
    assert(f.database.state.pending);
    await f.internals.finishPending();
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(f.database.state.documents.a.base!.vaultUpdateId, 2);
    assert.equal(f.database.state.documents.a.rejected, undefined);
    assert.equal(f.database.state.pending, undefined);
});

test("a persisted upload rejection finishes without filesystem writes", async () => {
    let uploads = 0;
    const f = await fixture(undefined, {
        putFileContent: async () => {
            uploads++;
            throw new PermanentSyncError("HTTP 413");
        }
    });
    f.internals.stopped = false;
    await f.internals.preparePush();
    f.disk.boundary = (label) => {
        if (!label.startsWith("read:"))
            throw new Error("Unexpected filesystem mutation");
    };
    await f.internals.finishPending();
    assert.equal(uploads, 1);
    assert.equal(f.database.state.pending, undefined);
    assert.equal(f.database.state.documents.a.rejected?.message, "HTTP 413");
    assert.deepEqual(f.disk.userFiles(), new Map([["a.md", bytes("local")]]));
});

test("event replay incorporates an earlier accepted upload after a permanent retry rejection", async () => {
    const f = await fixture(undefined, {
        putFileContent: async () => {
            throw new PermanentSyncError(
                "HTTP 413 after proxy reconfiguration"
            );
        },
        getDocumentVersionContent: async () => bytes("local")
    });
    f.internals.stopped = false;
    await f.internals.preparePush();
    const { pending } = f.database.state;
    assert(pending);
    const { requestId } = pending.request;
    await f.internals.finishPending();
    await assert.rejects(f.syncer.waitUntilFinished(), /413/);
    f.database.state.lastSeenUpdateId = 1;
    await f.internals.incorporateEventBatch({
        headEventId: 2,
        events: [
            {
                eventId: 2,
                requestId,
                type: "content",
                document: head("a", 2, "local")
            }
        ]
    });
    assert.equal(f.database.state.documents.a.base?.vaultUpdateId, 2);
    assert.equal(f.database.state.pending, undefined);
    assert.equal(await f.internals.preparePush(), false);
    await f.syncer.waitUntilFinished();
    assert.deepEqual(f.disk.userFiles(), new Map([["a.md", bytes("local")]]));
});

test("rejected manifests can be replaced after editing the local namespace", async () => {
    let reject = true;
    const f = await fixture(
        {},
        {
            pushFileManifest: async () => {
                if (reject) throw new PermanentSyncError("HTTP 413");
                return { type: "Accepted", fileManifestId: 3 };
            }
        }
    );
    f.database.state.fileManifest.entries = { a: "old.md" };
    f.database.state.pending = {
        type: "fileManifest",
        request: {
            requestId: "request",
            parentFileManifestId: 1,
            entries: { a: "new.md" }
        }
    };
    f.database.state.local = { a: "new.md" };
    f.database.state.documents.a = {
        materialized: false,
        base: { ...head("a", 1, "x"), hash: "hash" }
    };
    await f.database.save();
    await f.internals.finishPending();
    f.internals.stopped = false;
    assert.equal(await f.internals.preparePush(), false);
    f.database.state.local = {};
    reject = false;
    assert(await f.internals.preparePush());
    await f.internals.finishPending();
    assert.deepEqual(f.database.state.fileManifest.entries, {});
});

test("offline delete/recreate identities survive restarting before any network connection", async () => {
    const key = JSON.stringify(["http://offline.test", "test"]);
    const initial = emptyState(key);
    initial.initialized = true;
    initial.local.a = "a.md";
    initial.documents.a = { materialized: true };
    initial.fileManifest = { fileManifestId: 1, entries: { a: "a.md" } };
    const disk = new MemoryDisk();
    await disk.userWrite("a.md", bytes("same"));
    const persistence = new MemoryPersistence({
        database: initial,
        settings: { remoteUri: "http://offline.test", vaultName: "test" }
    });
    const first = await SyncClient.create({ fs: disk, persistence });
    await disk.userDelete("a.md");
    await first.syncLocallyDeletedFile("a.md");
    await disk.userWrite("a.md", bytes("same"));
    await first.syncLocallyCreatedFile("a.md");
    await first.destroy();
    const second = await SyncClient.create({ fs: disk, persistence });
    try {
        const internals = second as unknown as {
            syncer: { scan(): Promise<void> };
            database: Database;
        };
        await internals.syncer.scan();
        assert.equal(internals.database.state.local.a, undefined);
        assert.equal(
            Object.values(internals.database.state.local).filter(
                (path) => path === "a.md"
            ).length,
            1
        );
    } finally {
        await second.destroy();
    }
});

test("offline notifications bind an otherwise empty client to its vault", async () => {
    const disk = new MemoryDisk();
    await disk.userWrite("a.md", bytes("local"));
    const persistence = new MemoryPersistence({
        settings: { remoteUri: "http://offline.test", vaultName: "test" }
    });
    const client = await SyncClient.create({ fs: disk, persistence });
    await client.syncLocallyCreatedFile("a.md");
    await assert.rejects(
        client.setSettings({ vaultName: "other" }),
        /separate state store/
    );
    await client.destroy();
    const stored = persistence.snapshot();
    stored.settings!.vaultName = "other";
    await persistence.save(stored);
    await assert.rejects(
        SyncClient.create({ fs: disk, persistence }),
        /another vault/
    );
});

test("unignoring a deleted file resumes the deferred remote deletion without resurrection", async () => {
    const f = await fixture();
    await f.settings.setSettings({ ignorePatterns: ["a.md"] });
    await f.internals.incorporateFileManifest({
        fileManifestId: 2,
        entries: {}
    });
    await f.settings.setSettings({ ignorePatterns: [] });
    await f.internals.incorporateFileManifest(f.database.state.fileManifest);
    assert.equal(f.disk.userFiles().size, 0);
    assert.deepEqual(f.database.state.local, {});
});

test("an ignored file does not move when a remote rename targets its path", async () => {
    const f = await fixture({ "a.md": "A", "b.md": "B" });
    await f.settings.setSettings({ ignorePatterns: ["a.md"] });
    await f.internals.incorporateFileManifest({
        fileManifestId: 2,
        entries: { a: "c.md", b: "a.md" }
    });
    assert.deepEqual(
        f.disk.userFiles(),
        new Map([
            ["a.md", bytes("A")],
            ["b.md", bytes("B")]
        ])
    );
    f.internals.stopped = false;
    assert.equal(await f.internals.preparePush(), false);
    assert.deepEqual(
        f.disk.userFiles(),
        new Map([
            ["a.md", bytes("A")],
            ["b.md", bytes("B")]
        ])
    );
});

for (const kind of ["path", "content"] as const) {
    test(`a remote ${kind} change that was reverted before observation preserves the local edit`, async () => {
        const f = await fixture(
            { "a.md": "local" },
            {
                getDocumentVersionContent: async ({ vaultUpdateId }) =>
                    bytes(vaultUpdateId === 2 ? "temporary" : "base")
            }
        );
        f.database.state.lastSeenUpdateId = 1;
        f.database.state.documents.a.base = {
            ...head("a", 1, "base"),
            hash: (await toStoredSnapshot({ content: bytes("base") })).hash
        };
        if (kind === "path") {
            await f.disk.userRename("a.md", "c.md");
            await f.syncer.syncLocallyUpdatedFile({
                oldPath: "a.md",
                relativePath: "c.md"
            });
        }
        await f.internals.incorporateEventBatch({
            headEventId: 3,
            events: [2, 3].map((id) =>
                kind === "path"
                    ? {
                          eventId: id,
                          requestId: String(id),
                          type: "fileManifest",
                          fileManifest: {
                              fileManifestId: id,
                              entries: { a: id === 2 ? "b.md" : "a.md" }
                          }
                      }
                    : {
                          eventId: id,
                          requestId: String(id),
                          type: "content",
                          document: head(
                              "a",
                              id,
                              id === 2 ? "temporary" : "base"
                          )
                      }
            )
        });
        assert.equal(
            f.database.state.local.a,
            kind === "path" ? "c.md" : "a.md"
        );
        assert.equal(
            Buffer.from(
                (await f.disk.readSnapshot(f.database.state.local.a))!.content
            ).toString(),
            "local"
        );
        assert.equal(f.database.state.lastSeenUpdateId, 3);
    });
}

test("concurrent settings updates cannot bind the engine to a different vault than its settings", async () => {
    const disk = new MemoryDisk();
    const persistence = new MemoryPersistence();
    const client = await SyncClient.create({ fs: disk, persistence });
    try {
        await Promise.all([
            client.setSettings({ vaultName: "changed" }),
            client.setSettings({ maxFileSizeMB: 20 })
        ]);
        const stored = persistence.snapshot();
        assert.equal(
            stored.database!.vaultKey,
            JSON.stringify([
                stored.settings!.remoteUri,
                stored.settings!.vaultName
            ])
        );
        assert.equal(stored.settings!.maxFileSizeMB, 20);
    } finally {
        await client.destroy();
    }
});

test("destroy waits for an in-progress offline notification to become durable", async () => {
    const disk = new MemoryDisk();
    const persistence = new MemoryPersistence();
    const client = await SyncClient.create({ fs: disk, persistence });
    await disk.userWrite("a.md", bytes("local"));
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    persistence.boundary = async (label) => {
        if (label === "before:save") {
            reached.resolve();
            await release.promise;
        }
    };
    const notification = client.syncLocallyCreatedFile("a.md");
    await reached.promise;
    let destroyed = false;
    const destroying = client.destroy().then(() => {
        destroyed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(destroyed, false);
    release.resolve();
    await Promise.all([notification, destroying]);
});

test("ignoring a locally renamed file defers its move without forgetting the local rename", async () => {
    const f = await fixture();
    f.database.state.documents.a.base = {
        ...head("a", 1, "local"),
        hash: f.database.state.documents.a.observedHash!
    };
    await f.disk.userRename("a.md", "ignored.md");
    await f.syncer.syncLocallyUpdatedFile({
        oldPath: "a.md",
        relativePath: "ignored.md"
    });
    await f.settings.setSettings({ ignorePatterns: ["ignored.md"] });
    await f.internals.scan();
    f.internals.stopped = false;
    assert.equal(await f.internals.preparePush(), false);
    await f.internals.incorporateFileManifest({
        fileManifestId: 2,
        entries: { a: "a.md" }
    });
    await f.settings.setSettings({ ignorePatterns: [] });
    await f.internals.incorporateFileManifest(f.database.state.fileManifest);
    assert.equal(f.database.state.local.a, "ignored.md");
    assert.equal(
        Buffer.from(
            (await f.disk.readSnapshot("ignored.md"))!.content
        ).toString(),
        "local"
    );
});

test("a notified deletion of an ignored file does not delete its server membership", async () => {
    const f = await fixture();
    await f.settings.setSettings({ ignorePatterns: ["a.md"] });
    await f.disk.userDelete("a.md");
    await f.syncer.syncLocallyDeletedFile("a.md");
    await f.internals.scan();
    f.internals.stopped = false;
    assert.equal(await f.internals.preparePush(), false);
    assert.equal(f.database.state.local.a, undefined);
    await f.settings.setSettings({ ignorePatterns: [] });
    await f.internals.incorporateFileManifest(f.database.state.fileManifest);
    assert(await f.internals.preparePush());
    assert.equal(f.database.state.pending?.type, "fileManifest");
});

test("an incoming ignored document cannot force an existing ignored file to move", async () => {
    const f = await fixture();
    await f.settings.setSettings({ ignorePatterns: ["a.md", "*conflict*"] });
    await f.internals.incorporateFileManifest({
        fileManifestId: 2,
        entries: { a: "b.md", other: "a.md" }
    });
    f.internals.stopped = false;
    await f.internals.preparePush();
    assert.deepEqual(f.disk.userFiles(), new Map([["a.md", bytes("local")]]));
    assert.equal(
        new Set(Object.values(f.database.state.local)).size,
        Object.keys(f.database.state.local).length
    );
});

test("rejected content is reported to callers and an explicit retry clears the rejection", async () => {
    const f = await fixture(undefined, {
        putFileContent: async () => {
            throw new PermanentSyncError("HTTP 413");
        }
    });
    f.internals.stopped = false;
    await f.internals.preparePush();
    await f.internals.finishPending();
    await assert.rejects(f.syncer.waitUntilFinished(), /413/);
    assert(f.syncer.isBusy);
    await f.syncer.retryRejectedRequests();
    assert(await f.internals.preparePush());
});

test("notification saves cannot roll back an uncertain engine commit, even if the first reload fails", async () => {
    const key = JSON.stringify(["http://offline.test", "test"]);
    const initial = emptyState(key);
    initial.initialized = true;
    const disk = new MemoryDisk();
    const store = new MemoryPersistence({
        database: initial,
        settings: { remoteUri: "http://offline.test", vaultName: "test" }
    });
    let failLoad = false;
    const persistence = {
        load: async () => {
            if (failLoad) {
                failLoad = false;
                throw new Error("reload failed");
            }
            return store.load();
        },
        save: async (state: Parameters<typeof store.save>[0]) =>
            store.save(state)
    };
    const client = await SyncClient.create({ fs: disk, persistence });
    try {
        const internals = client as unknown as {
            database: Database;
            syncer: Syncer;
        };
        const next = structuredClone(initial);
        next.lastSeenUpdateId = 2;
        store.boundary = (label) => {
            if (label === "durable:save") {
                store.boundary = () => {};
                throw new Error("durable save failed");
            }
        };
        await assert.rejects(
            internals.database.commit(next),
            /durable save failed/
        );
        await disk.userWrite("a.md", bytes("new"));
        failLoad = true;
        await assert.rejects(
            client.syncLocallyCreatedFile("a.md"),
            /reload failed/
        );
        await internals.syncer.flushLocalChanges();
        assert.equal(store.snapshot().database!.lastSeenUpdateId, 2);
        await internals.database.recoverPersistence();
        assert.equal(internals.database.state.lastSeenUpdateId, 2);
    } finally {
        await client.destroy();
    }
});

test(
    "a settings listener can await client shutdown without deadlocking the lifecycle lock",
    { timeout: 1_000 },
    async () => {
        const client = await SyncClient.create({
            fs: new MemoryDisk(),
            persistence: new MemoryPersistence()
        });
        let notified = false;
        client.onSettingsChanged.add(async () => {
            await client.destroy();
            notified = true;
        });
        await client.setSettings({ maxFileSizeMB: 20 });
        assert(notified);
    }
);
