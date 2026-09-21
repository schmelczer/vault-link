/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import assert from "node:assert/strict";
import { it } from "node:test";
import type { Database } from "../persistence/database";
import type { FileOperations } from "../file-operations/file-operations";
import type { WebSocketManager } from "../services/websocket-manager";
import type { ClientCursors } from "../services/types/ClientCursors";
import { DocumentUpToDateness } from "../types/document-up-to-dateness";
import { EventListeners } from "../utils/data-structures/event-listeners";
import { hash } from "../utils/hash";
import { CursorTracker } from "./cursor-tracker";
import { FileChangeNotifier } from "./file-change-notifier";

it("retains future cursors and publishes them when content catches up", async () => {
    const content = new TextEncoder().encode("current");
    const contentHash = await hash(content);
    const database = {
        getDocumentByDocumentId: () => ({
            documentId: "document",
            relativePath: "note.md",
            metadata: { parentVersionId: 2, hash: contentHash }
        })
    } as unknown as Database;
    const websocket = {
        onWebSocketStatusChanged: new EventListeners<
            (connected: boolean) => unknown
        >(),
        onRemoteCursorsUpdateReceived: new EventListeners<
            (cursors: ClientCursors[]) => Promise<void>
        >(),
        updateLocalCursors: () => {}
    } as unknown as WebSocketManager;
    const files = { read: async () => content } as unknown as FileOperations;
    const notifier = new FileChangeNotifier();
    const tracker = new CursorTracker(database, websocket, files, notifier);
    const future = {
        userName: "Other",
        deviceId: "device",
        documentsWithCursors: [
            {
                document_id: "document",
                relative_path: "old-name.md",
                vault_update_id: 2,
                cursors: [{ start: 0, end: 1 }]
            }
        ],
        upToDateness: DocumentUpToDateness.Later
    };
    const internals = tracker as unknown as {
        knownRemoteCursors: (typeof future)[];
        getRelevantAndPruneKnownClientCursors: () => ClientCursors[];
    };
    internals.knownRemoteCursors = [future];

    assert.deepEqual(internals.getRelevantAndPruneKnownClientCursors(), []);
    assert.strictEqual(internals.knownRemoteCursors.length, 1);

    let received: ClientCursors[] = [];
    tracker.onRemoteCursorsUpdated.add((cursors) => {
        received = cursors;
    });
    await notifier.onFileChanged.triggerAsync("note.md");

    assert.strictEqual(received.length, 1);
    assert.strictEqual(
        received[0].documentsWithCursors[0].relative_path,
        "note.md"
    );
});

it("refreshes unchanged cursors on reconnect and heartbeat, and follows the document through renames", async (context) => {
    context.mock.timers.enable({ apis: ["setInterval"] });
    const content = new TextEncoder().encode("hello");
    let path = "note.md";
    const record = () => ({
        documentId: "document",
        relativePath: path,
        metadata: { parentVersionId: 1, hash: contentHash }
    });
    const contentHash = await hash(content);
    const database = {
        getLatestDocumentByRelativePath: (candidate: string) =>
            candidate === path ? record() : undefined,
        getDocumentByDocumentId: () => record()
    } as unknown as Database;
    const sent: {
        documentsWithCursors: {
            relative_path: string;
            vault_update_id: number | null;
        }[];
    }[] = [];
    const websocket = {
        onWebSocketStatusChanged: new EventListeners<
            (connected: boolean) => unknown
        >(),
        onRemoteCursorsUpdateReceived: new EventListeners(),
        updateLocalCursors: (value: (typeof sent)[number]) => {
            sent.push(value);
        }
    } as unknown as WebSocketManager;
    const notifier = new FileChangeNotifier();
    const tracker = new CursorTracker(
        database,
        websocket,
        { read: async () => content } as unknown as FileOperations,
        notifier
    );
    const drain = async () => {
        for (let i = 0; i < 20; i++)
            await new Promise((resolve) => setImmediate(resolve));
    };
    try {
        await tracker.sendLocalCursorsToServer({
            "note.md": [{ start: 1, end: 2 }]
        });
        assert.equal(sent.length, 1);
        await tracker.sendLocalCursorsToServer({
            "note.md": [{ start: 1, end: 2 }]
        });
        assert.equal(sent.length, 1);
        websocket.onWebSocketStatusChanged.trigger(true);
        await drain();
        assert.equal(sent.length, 2);
        context.mock.timers.tick(15_000);
        await drain();
        assert.equal(sent.length, 3);
        path = "renamed.md";
        await notifier.onFileChanged.triggerAsync(path);
        assert.equal(sent.at(-1)!.documentsWithCursors[0].relative_path, path);
        websocket.onWebSocketStatusChanged.trigger(false);
        const count = sent.length;
        context.mock.timers.tick(30_000);
        await drain();
        assert.equal(sent.length, count);
        websocket.onWebSocketStatusChanged.trigger(true);
        await drain();
        assert.equal(sent.length, count + 1);
    } finally {
        tracker.reset();
        context.mock.timers.reset();
    }
});

for (const interruption of ["disconnect", "reset"] as const) {
    it(`an in-flight cursor read cannot resurrect presence after ${interruption}`, async () => {
        const content = new TextEncoder().encode("current");
        const contentHash = await hash(content);
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const database = {
            getDocumentByDocumentId: () => ({
                documentId: "document",
                relativePath: "note.md",
                metadata: { parentVersionId: 1, hash: contentHash }
            })
        } as unknown as Database;
        const websocket = {
            onWebSocketStatusChanged: new EventListeners<
                (connected: boolean) => unknown
            >(),
            onRemoteCursorsUpdateReceived: new EventListeners<
                (cursors: ClientCursors[]) => Promise<void>
            >(),
            updateLocalCursors: () => {}
        } as unknown as WebSocketManager;
        const tracker = new CursorTracker(
            database,
            websocket,
            {
                read: async () => {
                    entered.resolve();
                    await release.promise;
                    return content;
                }
            } as unknown as FileOperations,
            new FileChangeNotifier()
        );
        let received: ClientCursors[] = [];
        tracker.onRemoteCursorsUpdated.add((cursors) => {
            received = cursors;
        });
        const cursor: ClientCursors = {
            userName: "Other",
            deviceId: "device",
            documentsWithCursors: [
                {
                    document_id: "document",
                    relative_path: "note.md",
                    vault_update_id: 1,
                    cursors: [{ start: 0, end: 1 }]
                }
            ]
        };
        const first = websocket.onRemoteCursorsUpdateReceived.triggerAsync([
            cursor
        ]);
        await entered.promise;
        const queued = websocket.onRemoteCursorsUpdateReceived.triggerAsync([
            cursor
        ]);
        if (interruption === "reset") tracker.reset();
        else websocket.onWebSocketStatusChanged.trigger(false);
        assert.deepEqual(received, []);
        release.resolve();
        await first;
        await queued;
        assert.deepEqual(
            received,
            [],
            "a retired connection must not restore its cursors"
        );
        tracker.reset();
    });
}

it("a remote cursor becomes outdated if the document advances during its snapshot read", async () => {
    const content = new TextEncoder().encode("old");
    let metadata = { parentVersionId: 1, hash: await hash(content) };
    const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
    const websocket = {
        onWebSocketStatusChanged: new EventListeners<
            (connected: boolean) => unknown
        >(),
        onRemoteCursorsUpdateReceived: new EventListeners<
            (cursors: ClientCursors[]) => Promise<void>
        >(),
        updateLocalCursors: () => {}
    } as unknown as WebSocketManager;
    const tracker = new CursorTracker(
        {
            getDocumentByDocumentId: () => ({
                documentId: "document",
                relativePath: "note.md",
                metadata
            })
        } as unknown as Database,
        websocket,
        {
            read: async () => {
                entered.resolve();
                await release.promise;
                return content;
            }
        } as unknown as FileOperations,
        new FileChangeNotifier()
    );
    let outdated: boolean | undefined;
    tracker.onRemoteCursorsUpdated.add((cursors) => {
        outdated = cursors[0]?.isOutdated;
    });
    const update = websocket.onRemoteCursorsUpdateReceived.triggerAsync([
        {
            userName: "Other",
            deviceId: "device",
            documentsWithCursors: [
                {
                    document_id: "document",
                    relative_path: "note.md",
                    vault_update_id: 1,
                    cursors: [{ start: 0, end: 1 }]
                }
            ]
        }
    ]);
    await entered.promise;
    metadata = {
        parentVersionId: 2,
        hash: await hash(new TextEncoder().encode("new content"))
    };
    release.resolve();
    await update;
    assert.equal(outdated, true);
    tracker.reset();
});
