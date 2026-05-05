import { describe, it } from "node:test";
import assert from "node:assert";
import {
    STORED_STATE_SCHEMA_VERSION,
    SyncEventQueue
} from "./sync-event-queue";
import { Settings } from "../persistence/settings";
import { Logger } from "../tracing/logger";
import type { DocumentVersionWithoutContent } from "../services/types/DocumentVersionWithoutContent";
import { SyncEventType } from "./types";
import type { DocumentRecord, RelativePath, StoredSyncState } from "./types";

interface QueueHarness {
    queue: SyncEventQueue;
    settings: Settings;
    saveCalls: StoredSyncState[];
}

function createHarness(
    options: {
        ignorePatterns?: string[];
        initialState?: Partial<StoredSyncState>;
        omitSchemaVersion?: boolean;
    } = {}
): QueueHarness {
    const logger = new Logger();
    const settings = new Settings(
        logger,
        { ignorePatterns: options.ignorePatterns ?? [] },
        async () => {
            /* no-op */
        }
    );

    const saveCalls: StoredSyncState[] = [];
    const initialState: Partial<StoredSyncState> | undefined =
        options.initialState === undefined && options.omitSchemaVersion !== true
            ? { schemaVersion: STORED_STATE_SCHEMA_VERSION }
            : options.initialState;

    const queue = new SyncEventQueue(
        settings,
        logger,
        initialState,
        async (data) => {
            saveCalls.push(data);
        }
    );
    return { queue, settings, saveCalls };
}

function createQueue(ignorePatterns: string[] = []): SyncEventQueue {
    return createHarness({ ignorePatterns }).queue;
}

function fakeRemoteVersion(
    documentId: string,
    overrides: Partial<DocumentVersionWithoutContent> = {}
): DocumentVersionWithoutContent {
    return {
        vaultUpdateId: 1,
        documentId,
        relativePath: `${documentId}.md`,
        updatedDate: "2026-01-01",
        isDeleted: false,
        userId: "user",
        deviceId: "device",
        contentSize: 100,
        isNewFile: true,
        ...overrides
    };
}

function fakeRecord(
    documentId: string,
    overrides: Partial<DocumentRecord> = {}
): DocumentRecord {
    const path = `${documentId.toLowerCase()}.md`;
    return {
        documentId,
        parentVersionId: 1,
        remoteHash: `hash-${documentId}`,
        remoteRelativePath: path,
        localPath: path,
        ...overrides
    };
}

describe("SyncEventQueue", () => {
    it("returns enqueued events in FIFO order with no coalescing", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "c.md" });
        await queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.LocalCreate);

        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.LocalCreate);

        const third = await queue.next();
        assert.strictEqual(third?.type, SyncEventType.LocalDelete);
        assert.strictEqual(third.documentId, "A");

        assert.strictEqual(await queue.next(), undefined);
    });

    it("create events are returned FIFO", async () => {
        const queue = createQueue();
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });

        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.LocalCreate);
        assert.strictEqual(first.path, "a.md");

        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.LocalCreate);
        assert.strictEqual(second.path, "b.md");
    });

    it("delete resolves documentId from path", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));

        await queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        const event = await queue.next();
        assert.strictEqual(event?.type, SyncEventType.LocalDelete);
        assert.strictEqual(event.documentId, "A");
    });

    it("delete for unknown path is silently ignored", async () => {
        const queue = createQueue();
        await queue.enqueue({
            type: SyncEventType.LocalDelete,
            path: "unknown.md"
        });
        assert.strictEqual(queue.pendingUpdateCount, 0);
    });

    it("delete clears the localPath of the affected record", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));

        await queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        const record = queue.getDocumentByDocumentId("A");
        assert.ok(record !== undefined);
        assert.strictEqual(record.localPath, undefined);
        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath),
            undefined
        );
    });

    it("document store CRUD operations work correctly", async () => {
        const queue = createQueue();

        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath),
            undefined
        );
        assert.strictEqual(queue.syncedDocumentCount, 0);

        await queue.upsertRecord(fakeRecord("A"));
        assert.strictEqual(queue.syncedDocumentCount, 1);

        const settled = queue.getRecordByLocalPath("a.md" as RelativePath);
        assert.strictEqual(settled?.documentId, "A");
        assert.strictEqual(settled.localPath, "a.md");
        assert.strictEqual(settled.remoteRelativePath, "a.md");

        const found = queue.getDocumentByDocumentId("A");
        assert.strictEqual(found?.localPath, "a.md");
        assert.strictEqual(found.documentId, "A");

        await queue.removeDocumentById("A");
        assert.strictEqual(queue.syncedDocumentCount, 0);
        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath),
            undefined
        );
        assert.strictEqual(queue.getDocumentByDocumentId("A"), undefined);
    });

    it("LocalUpdate with oldPath moves the document on disk", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));

        await queue.enqueue({
            type: SyncEventType.LocalUpdate,
            path: "b.md",
            oldPath: "a.md"
        });

        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath),
            undefined
        );
        const moved = queue.getRecordByLocalPath("b.md" as RelativePath);
        assert.strictEqual(moved?.documentId, "A");
        assert.strictEqual(moved.localPath, "b.md");

        // The doc's remoteRelativePath is owned by the wire loop, not the
        // watcher path — a local rename does not move the server-side path.
        assert.strictEqual(moved.remoteRelativePath, "a.md");
    });

    it("LocalUpdate rename onto a tracked slot enqueues a delete for the displaced doc", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));
        await queue.upsertRecord(fakeRecord("B"));

        // User renames a.md onto b.md, clobbering b.md on disk.
        await queue.enqueue({
            type: SyncEventType.LocalUpdate,
            path: "b.md",
            oldPath: "a.md"
        });

        // Doc A now lives at b.md.
        const aRecord = queue.getDocumentByDocumentId("A");
        assert.strictEqual(aRecord?.localPath, "b.md");
        const slot = queue.getRecordByLocalPath("b.md" as RelativePath);
        assert.strictEqual(slot?.documentId, "A");

        // Doc B has no local file anymore (its bytes were overwritten).
        const bRecord = queue.getDocumentByDocumentId("B");
        assert.strictEqual(bRecord?.localPath, undefined);

        // Two events should be queued: the LocalDelete for B, then the
        // LocalUpdate for A (push order in `enqueue`).
        assert.strictEqual(queue.pendingUpdateCount, 2);

        const first = await queue.next();
        assert.strictEqual(first?.type, SyncEventType.LocalDelete);
        assert.strictEqual(first.documentId, "B");
        assert.strictEqual(first.path, "b.md");

        const second = await queue.next();
        assert.strictEqual(second?.type, SyncEventType.LocalUpdate);
        assert.strictEqual(second.documentId, "A");
        assert.strictEqual(second.path, "b.md");
        assert.strictEqual(second.isUserRename, true);
    });

    it("settled record owns a path over a stale pending create", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A", { localPath: "b.md" }));

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });
        await queue.enqueue({
            type: SyncEventType.LocalUpdate,
            path: "c.md",
            oldPath: "b.md"
        });

        const aRecord = queue.getDocumentByDocumentId("A");
        assert.strictEqual(aRecord?.localPath, "c.md");
        assert.strictEqual(
            queue.getRecordByLocalPath("b.md" as RelativePath),
            undefined
        );
        assert.strictEqual(
            queue.getRecordByLocalPath("c.md" as RelativePath)?.documentId,
            "A"
        );

        const create = await queue.next();
        assert.strictEqual(create?.type, SyncEventType.LocalCreate);
        assert.strictEqual(create.path, "b.md");

        const update = await queue.next();
        assert.strictEqual(update?.type, SyncEventType.LocalUpdate);
        assert.strictEqual(update.documentId, "A");
        assert.strictEqual(update.path, "c.md");
    });

    it("byLocalPath stays consistent across upsertRecord, setLocalPath, and rename", async () => {
        const queue = createQueue();

        await queue.upsertRecord(fakeRecord("A"));
        assert.strictEqual(queue.byLocalPath.size, 1);
        assert.strictEqual(
            queue.byLocalPath.get("a.md" as RelativePath)?.documentId,
            "A"
        );

        // upsertRecord that relocates the localPath should re-key.
        await queue.upsertRecord(
            fakeRecord("A", { localPath: "renamed.md" as RelativePath })
        );
        assert.strictEqual(queue.byLocalPath.size, 1);
        assert.strictEqual(
            queue.byLocalPath.get("a.md" as RelativePath),
            undefined
        );
        assert.strictEqual(
            queue.byLocalPath.get("renamed.md" as RelativePath)?.documentId,
            "A"
        );

        // setLocalPath should re-key.
        await queue.setLocalPath("A", "later.md" as RelativePath);
        assert.strictEqual(queue.byLocalPath.size, 1);
        assert.strictEqual(
            queue.byLocalPath.get("renamed.md" as RelativePath),
            undefined
        );
        assert.strictEqual(
            queue.byLocalPath.get("later.md" as RelativePath)?.documentId,
            "A"
        );

        // setLocalPath to undefined should drop the entry.
        await queue.setLocalPath("A", undefined);
        assert.strictEqual(queue.byLocalPath.size, 0);
        assert.strictEqual(
            queue.byLocalPath.get("later.md" as RelativePath),
            undefined
        );

        // The record is still tracked by docId.
        assert.strictEqual(
            queue.getDocumentByDocumentId("A")?.localPath,
            undefined
        );
    });

    it("create can be re-enqueued after being dequeued", async () => {
        const queue = createQueue();
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        await queue.next();

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        assert.strictEqual(queue.pendingUpdateCount, 1);
    });

    it("silently ignores create events matching ignore patterns", async () => {
        const queue = createQueue(["*.tmp", ".hidden/**"]);

        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: "scratch.tmp"
        });
        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: ".hidden/secret.md"
        });
        assert.strictEqual(queue.pendingUpdateCount, 0);

        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: "notes-new.md"
        });
        assert.strictEqual(queue.pendingUpdateCount, 1);

        await queue.enqueue({
            type: SyncEventType.RemoteChange,
            remoteVersion: fakeRemoteVersion("N")
        });
        assert.strictEqual(queue.pendingUpdateCount, 2);
    });

    it("addInternalIgnorePattern hides paths from enqueue and survives settings reload", async () => {
        const harness = createHarness({ ignorePatterns: ["*.tmp"] });
        const { queue, settings } = harness;

        queue.addInternalIgnorePattern(".vaultlink/**");

        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: ".vaultlink/swap"
        });
        assert.strictEqual(queue.pendingUpdateCount, 0);

        // User-pattern matching still works alongside the internal pattern.
        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: "scratch.tmp"
        });
        assert.strictEqual(queue.pendingUpdateCount, 0);

        // Settings reload must not forget the internal pattern.
        await settings.setSettings({ ignorePatterns: ["*.bak"] });

        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: ".vaultlink/another"
        });
        assert.strictEqual(queue.pendingUpdateCount, 0);

        // The new user pattern took effect.
        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: "old.bak"
        });
        assert.strictEqual(queue.pendingUpdateCount, 0);

        // And paths outside both pattern sets still pass through.
        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: "notes.md"
        });
        assert.strictEqual(queue.pendingUpdateCount, 1);
    });

    it("clearPending removes events but keeps documents", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "c.md" });

        assert.strictEqual(queue.pendingUpdateCount, 2);

        queue.clearPending();

        assert.strictEqual(queue.pendingUpdateCount, 0);
        assert.strictEqual(queue.syncedDocumentCount, 1);
        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath)?.documentId,
            "A"
        );
    });

    it("allSettledDocuments returns all tracked documents that have a localPath", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));
        await queue.upsertRecord(fakeRecord("B"));
        // A doc with no local file (e.g. a remote create whose slot was
        // occupied) should not appear in the localPath-keyed view.
        await queue.upsertRecord(fakeRecord("C", { localPath: undefined }));

        const docs = queue.allSettledDocuments();
        assert.strictEqual(docs.size, 2);
        const paths = Array.from(docs.keys()).sort();
        assert.deepStrictEqual(paths, ["a.md", "b.md"]);
    });

    it("loads initial state from persistence", () => {
        const harness = createHarness({
            initialState: {
                schemaVersion: STORED_STATE_SCHEMA_VERSION,
                documents: [
                    fakeRecord("A", { parentVersionId: 5 }),
                    fakeRecord("B", { parentVersionId: 3 })
                ],
                lastSeenUpdateId: 4
            }
        });
        const { queue } = harness;

        assert.strictEqual(queue.syncedDocumentCount, 2);
        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath)?.documentId,
            "A"
        );
        assert.strictEqual(
            queue.getRecordByLocalPath("b.md" as RelativePath)?.documentId,
            "B"
        );
        assert.strictEqual(queue.lastSeenUpdateId, 4);
    });

    it("constructor with mismatched schema version wipes state and saves the new version", () => {
        const harness = createHarness({
            initialState: {
                schemaVersion: 0,
                documents: [fakeRecord("A"), fakeRecord("B")],
                lastSeenUpdateId: 7
            }
        });

        // Persisted documents and watermark were discarded.
        assert.strictEqual(harness.queue.syncedDocumentCount, 0);
        assert.strictEqual(harness.queue.lastSeenUpdateId, 0);

        // The constructor scheduled a save (don't await — fire-and-forget),
        // but we synchronously enqueued it so it should have landed by now.
        // The recorded save uses the current schema version.
        assert.ok(harness.saveCalls.length >= 1);
        const last = harness.saveCalls[harness.saveCalls.length - 1];
        assert.strictEqual(last.schemaVersion, STORED_STATE_SCHEMA_VERSION);
        assert.deepStrictEqual(last.documents, []);
        assert.strictEqual(last.lastSeenUpdateId, 0);
    });

    it("constructor with missing schema version also wipes state", () => {
        const harness = createHarness({
            initialState: {
                documents: [fakeRecord("A")],
                lastSeenUpdateId: 3
            }
        });

        assert.strictEqual(harness.queue.syncedDocumentCount, 0);
        assert.strictEqual(harness.queue.lastSeenUpdateId, 0);
        assert.ok(harness.saveCalls.length >= 1);
        assert.strictEqual(
            harness.saveCalls[harness.saveCalls.length - 1].schemaVersion,
            STORED_STATE_SCHEMA_VERSION
        );
    });

    it("resolveCreate settles the document and resolves the create promise", async () => {
        const queue = createQueue();

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });

        const event = await queue.next(); // dequeue the create
        assert.ok(event?.type === SyncEventType.LocalCreate);
        const createPromise = event.resolvers.promise;

        await queue.resolveCreate(
            event,
            fakeRecord("DOC-1", {
                parentVersionId: 5,
                localPath: "a.md" as RelativePath,
                remoteRelativePath: "a.md" as RelativePath
            })
        );

        // Document is now settled
        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath)?.documentId,
            "DOC-1"
        );

        // Promise was resolved
        assert.strictEqual(await createPromise, "DOC-1");
    });

    it("delete collapses a pending create that has not started processing", async () => {
        const queue = createQueue();

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        const create = queue.peekFront();
        assert.ok(create?.type === SyncEventType.LocalCreate);

        await queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        assert.strictEqual(queue.pendingUpdateCount, 0);
        assert.strictEqual(await queue.next(), undefined);
        await assert.rejects(create.resolvers.promise, /cancelled/);
    });

    it("resolveCreate does not claim a localPath after an in-flight pending create was deleted", async () => {
        const queue = createQueue();

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        const create = queue.peekFront();
        assert.ok(create?.type === SyncEventType.LocalCreate);
        create.isProcessing = true;

        await queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        await queue.resolveCreate(
            create,
            fakeRecord("DOC-1", {
                localPath: "a.md" as RelativePath,
                remoteRelativePath: "a.md" as RelativePath
            })
        );

        assert.strictEqual(
            queue.getDocumentByDocumentId("DOC-1")?.localPath,
            undefined
        );
        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath),
            undefined
        );

        const deleteEvent = await queue.next();
        assert.strictEqual(deleteEvent?.type, SyncEventType.LocalDelete);
        assert.strictEqual(deleteEvent.documentId, "DOC-1");
    });

    it("resolveCreate only clears localPath for a pending delete of that path", async () => {
        const queue = createQueue();

        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: "old.md"
        });
        const create = queue.peekFront();
        assert.ok(create?.type === SyncEventType.LocalCreate);
        create.isProcessing = true;

        await queue.enqueue({
            type: SyncEventType.LocalDelete,
            path: "old.md"
        });

        await queue.resolveCreate(
            create,
            fakeRecord("DOC-1", {
                localPath: "new.md" as RelativePath,
                remoteRelativePath: "new.md" as RelativePath
            })
        );

        assert.strictEqual(
            queue.getDocumentByDocumentId("DOC-1")?.localPath,
            "new.md"
        );
        assert.strictEqual(
            queue.getRecordByLocalPath("new.md" as RelativePath)?.documentId,
            "DOC-1"
        );

        const deleteEvent = await queue.next();
        assert.strictEqual(deleteEvent?.type, SyncEventType.LocalDelete);
        assert.strictEqual(deleteEvent.documentId, "DOC-1");
        assert.strictEqual(deleteEvent.path, "old.md");
    });

    it("pending create owns a same-path delete over a stale deleting record", async () => {
        const queue = createQueue();
        await queue.upsertRecord(
            fakeRecord("OLD", { localPath: "a.md" as RelativePath })
        );
        queue.markServerDeletePending("OLD");

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        const create = queue.peekFront();
        assert.ok(create?.type === SyncEventType.LocalCreate);
        create.isProcessing = true;

        await queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });

        assert.strictEqual(
            queue.getDocumentByDocumentId("OLD")?.localPath,
            undefined
        );
        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath),
            undefined
        );

        const createEvent = await queue.next();
        assert.strictEqual(createEvent, create);

        const deleteEvent = await queue.next();
        assert.strictEqual(deleteEvent?.type, SyncEventType.LocalDelete);
        assert.strictEqual(deleteEvent.documentId, create.resolvers.promise);
    });

    it("rename of a queued create drains same-path deletes first", async () => {
        const queue = createQueue();
        await queue.upsertRecord(
            fakeRecord("OLD", { localPath: "target.md" as RelativePath })
        );

        await queue.enqueue({
            type: SyncEventType.LocalCreate,
            path: "source.md"
        });
        const create = queue.peekFront();
        assert.ok(create?.type === SyncEventType.LocalCreate);

        await queue.enqueue({
            type: SyncEventType.LocalDelete,
            path: "target.md"
        });
        await queue.enqueue({
            type: SyncEventType.LocalUpdate,
            oldPath: "source.md",
            path: "target.md"
        });

        const deleteEvent = await queue.next();
        assert.strictEqual(deleteEvent?.type, SyncEventType.LocalDelete);
        assert.strictEqual(deleteEvent.documentId, "OLD");
        assert.strictEqual(deleteEvent.path, "target.md");

        const createEvent = await queue.next();
        assert.strictEqual(createEvent, create);
        assert.strictEqual(createEvent.path, "target.md");

        const updateEvent = await queue.next();
        assert.strictEqual(updateEvent?.type, SyncEventType.LocalUpdate);
        assert.strictEqual(updateEvent.documentId, create.resolvers.promise);
        assert.strictEqual(updateEvent.path, "target.md");
    });

    it("findLatestCreateForPath returns the pending create", async () => {
        const queue = createQueue();

        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "a.md" });
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });

        const found = queue.findLatestCreateForPath("a.md" as RelativePath);
        assert.ok(found !== undefined);
        assert.strictEqual(found.path, "a.md");

        const missing = queue.findLatestCreateForPath("c.md" as RelativePath);
        assert.strictEqual(missing, undefined);
    });

    it("hasPendingEventsForPath reflects pending events", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));

        assert.strictEqual(
            queue.hasPendingEventsForPath("a.md" as RelativePath),
            false
        );

        await queue.enqueue({ type: SyncEventType.LocalDelete, path: "a.md" });
        // After a delete the localPath is cleared; an unknown path is treated
        // as "must be pending creation", so this still returns true.
        assert.strictEqual(
            queue.hasPendingEventsForPath("a.md" as RelativePath),
            true
        );
    });

    it("setLocalPath displaces a previous holder of the same path", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));
        await queue.upsertRecord(
            fakeRecord("B", { localPath: "b.md" as RelativePath })
        );

        // Move B onto a.md — the slot already held by A. The invariant
        // requires A's localPath to be cleared (placement-pending),
        // and byLocalPath["a.md"] === B.
        await queue.setLocalPath("B", "a.md" as RelativePath);

        const a = queue.getDocumentByDocumentId("A");
        const b = queue.getDocumentByDocumentId("B");
        assert.strictEqual(a?.localPath, undefined);
        assert.strictEqual(b?.localPath, "a.md");
        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath)?.documentId,
            "B"
        );
        // B's old slot is now empty — nothing else moved into it.
        assert.strictEqual(
            queue.getRecordByLocalPath("b.md" as RelativePath),
            undefined
        );
    });

    it("upsertRecord displaces a previous holder of the same path", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));

        // A new record (different docId) claims a.md. The prior holder
        // (A) must be displaced — its localPath cleared, and
        // byLocalPath["a.md"] now points at the new record.
        await queue.upsertRecord(
            fakeRecord("B", { localPath: "a.md" as RelativePath })
        );

        const a = queue.getDocumentByDocumentId("A");
        const b = queue.getDocumentByDocumentId("B");
        assert.strictEqual(a?.localPath, undefined);
        assert.strictEqual(b?.localPath, "a.md");
        assert.strictEqual(
            queue.getRecordByLocalPath("a.md" as RelativePath)?.documentId,
            "B"
        );
    });

    it("the localPath/byLocalPath invariant holds across rename + recreate cycles", async () => {
        // Construct the exact same-path create cycle that produces the
        // bug-D race: docA at P, then docB created at P (via
        // upsertRecord), and finally a setLocalPath that would move a
        // third doc onto P. The invariant must hold at every step:
        // exactly one record has localPath===P at any given time, and
        // byLocalPath.get(P) returns it.
        const queue = createQueue();

        const path = "p.md" as RelativePath;

        await queue.upsertRecord(
            fakeRecord("A", { localPath: path, remoteRelativePath: path })
        );

        // Sanity: A holds the slot.
        assert.strictEqual(queue.getRecordByLocalPath(path)?.documentId, "A");
        assert.strictEqual(queue.getDocumentByDocumentId("A")?.localPath, path);

        // docB created at P via upsertRecord (e.g. a remote create
        // that races A's local file onto the same slot). A must be
        // displaced.
        await queue.upsertRecord(
            fakeRecord("B", { localPath: path, remoteRelativePath: path })
        );
        assert.strictEqual(
            queue.getDocumentByDocumentId("A")?.localPath,
            undefined
        );
        assert.strictEqual(queue.getDocumentByDocumentId("B")?.localPath, path);
        assert.strictEqual(queue.getRecordByLocalPath(path)?.documentId, "B");

        // Now setLocalPath moves a third doc C onto P. B must in turn
        // be displaced; the invariant still holds.
        await queue.upsertRecord(
            fakeRecord("C", { localPath: "c.md" as RelativePath })
        );
        await queue.setLocalPath("C", path);
        assert.strictEqual(
            queue.getDocumentByDocumentId("B")?.localPath,
            undefined
        );
        assert.strictEqual(queue.getDocumentByDocumentId("C")?.localPath, path);
        assert.strictEqual(queue.getRecordByLocalPath(path)?.documentId, "C");

        // Across the whole cycle exactly one record holds the slot.
        const holders = Array.from(queue.allRecords()).filter(
            (r) => r.localPath === path
        );
        assert.strictEqual(holders.length, 1);
        assert.strictEqual(holders[0].documentId, "C");
    });

    it("clearAllState clears everything", async () => {
        const queue = createQueue();
        await queue.upsertRecord(fakeRecord("A"));
        await queue.enqueue({ type: SyncEventType.LocalCreate, path: "b.md" });

        await queue.clearAllState();

        assert.strictEqual(queue.syncedDocumentCount, 0);
        assert.strictEqual(queue.pendingUpdateCount, 0);
        assert.strictEqual(queue.byLocalPath.size, 0);
    });
});
