/* eslint-disable @typescript-eslint/no-unsafe-type-assertion */
import assert from "node:assert/strict";
import { it } from "node:test";
import {
    Database,
    createEmptyDatabase,
    type RelativePath,
    type VaultUpdateId
} from "../persistence/database";
import type { FileSystemOperations } from "../file-operations/filesystem-operations";
import type { WebSocketManager } from "../services/websocket-manager";
import type { ClientCursors } from "../services/types/ClientCursors";
import { EventListeners } from "../utils/data-structures/event-listeners";
import { hash } from "../utils/hash";
import { CursorTracker } from "./cursor-tracker";

function createDatabase(digest: string): Database {
    const state = createEmptyDatabase("test");
    state.local.document = "note.md";
    state.documents.document = { base: { vaultUpdateId: 1, hash: digest } };
    return new Database(
        state,
        async () => undefined,
        "test",
        async () => undefined
    );
}

it("keeps the last usable cursor while retaining only the latest future update", async (context) => {
    const content = new TextEncoder().encode("current");
    const contentHash = await hash(content);
    const database = createDatabase(contentHash);
    const websocket = {
        onWebSocketStatusChanged: new EventListeners(),
        onRemoteCursorsUpdateReceived: new EventListeners<
            (cursors: ClientCursors[]) => Promise<void>
        >(),
        updateLocalCursors: () => undefined
    } as unknown as WebSocketManager;
    const notifier = new EventListeners<(path: RelativePath) => unknown>();
    const tracker = new CursorTracker(
        database,
        websocket,
        { read: async () => ({ content }) } as unknown as FileSystemOperations,
        notifier
    );
    context.after(() => {
        tracker.reset();
    });
    let received: ClientCursors[] = [];
    tracker.onRemoteCursorsUpdated.add((cursors) => {
        received = cursors;
    });
    const cursor = (version: number): ClientCursors => ({
        userName: "Other",
        deviceId: "device",
        documentsWithCursors: [
            {
                document_id: "document",
                relative_path: "old-name.md",
                vault_update_id: version,
                cursors: [{ start: version, end: version }]
            }
        ]
    });
    for (const remoteVersion of [1, 2, 3]) {
        await websocket.onRemoteCursorsUpdateReceived.triggerAsync([
            cursor(remoteVersion)
        ]);
        assert.equal(received[0]?.documentsWithCursors[0]?.vault_update_id, 1);
    }

    assert.ok(database.state.documents.document);
    database.state.documents.document.base = {
        vaultUpdateId: 2,
        hash: contentHash
    };
    await notifier.triggerAsync("note.md");
    assert.equal(
        received[0]?.documentsWithCursors[0]?.vault_update_id,
        1,
        "superseded future cursors must not reappear"
    );
    database.state.documents.document.base = {
        vaultUpdateId: 3,
        hash: contentHash
    };
    await notifier.triggerAsync("note.md");
    assert.equal(received[0].documentsWithCursors[0].vault_update_id, 3);
    assert.equal(received[0].documentsWithCursors[0].relative_path, "note.md");
    await websocket.onRemoteCursorsUpdateReceived.triggerAsync([]);
    assert.deepEqual(received, []);
});

it(
    "refreshes unchanged cursors on reconnect and heartbeat, and follows the document through renames",
    { timeout: 5_000 },
    async (context) => {
        context.mock.timers.enable({ apis: ["setInterval"] });
        const content = new TextEncoder().encode("hello");
        let path = "note.md";
        const database = createDatabase(await hash(content));
        const sent: {
            documentsWithCursors: {
                relative_path: RelativePath;
                vault_update_id: VaultUpdateId | null;
            }[];
        }[] = [];
        let published = Promise.withResolvers<undefined>();
        const websocket = {
            onWebSocketStatusChanged: new EventListeners<
                (connected: boolean) => unknown
            >(),
            onRemoteCursorsUpdateReceived: new EventListeners(),
            updateLocalCursors: (value: (typeof sent)[number]) => {
                sent.push(value);
                published.resolve(undefined);
            }
        } as unknown as WebSocketManager;
        const notifier = new EventListeners<(path: RelativePath) => unknown>();
        const read = context.mock.fn(async () => ({ content }));
        const tracker = new CursorTracker(
            database,
            websocket,
            { read } as unknown as FileSystemOperations,
            notifier
        );
        const waitForSend = async (trigger: () => void): Promise<void> => {
            published = Promise.withResolvers<undefined>();
            trigger();
            // Hashing finishes outside the event loop; a fixed number of turns
            // cannot guarantee that the cursor snapshot has been published.
            await published.promise;
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
            await waitForSend(() => {
                websocket.onWebSocketStatusChanged.trigger(true);
            });
            assert.equal(sent.length, 2);
            await waitForSend(() => {
                context.mock.timers.tick(15_000);
            });
            assert.equal(sent.length, 3);
            path = "renamed.md";
            database.state.local.document = path;
            await notifier.triggerAsync(path);
            assert.equal(
                sent.at(-1)?.documentsWithCursors[0]?.relative_path,
                path
            );
            websocket.onWebSocketStatusChanged.trigger(false);
            const count = Number(sent.length);
            const readCount = read.mock.callCount();
            context.mock.timers.tick(30_000);
            // A surviving heartbeat would start a snapshot read in the send lock's
            // next microtask, even if hashing that snapshot has not finished yet.
            await Promise.resolve();
            assert.equal(read.mock.callCount(), readCount);
            assert.equal(sent.length, count);
            await waitForSend(() => {
                websocket.onWebSocketStatusChanged.trigger(true);
            });
            assert.equal(sent.length, count + 1);
        } finally {
            tracker.reset();
            context.mock.timers.reset();
        }
    }
);

for (const interruption of ["disconnect", "reset"] as const) {
    it(`an in-flight cursor read cannot resurrect presence after ${interruption}`, async () => {
        const content = new TextEncoder().encode("current");
        const contentHash = await hash(content);
        const entered = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        const database = createDatabase(contentHash);
        const websocket = {
            onWebSocketStatusChanged: new EventListeners<
                (connected: boolean) => unknown
            >(),
            onRemoteCursorsUpdateReceived: new EventListeners<
                (cursors: ClientCursors[]) => Promise<void>
            >(),
            updateLocalCursors: () => undefined
        } as unknown as WebSocketManager;
        const tracker = new CursorTracker(
            database,
            websocket,
            {
                read: async () => {
                    entered.resolve(undefined);
                    await release.promise;
                    return { content };
                }
            } as unknown as FileSystemOperations,
            new EventListeners<(path: RelativePath) => unknown>()
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
        if (interruption === "reset") {
            tracker.reset();
        } else {
            websocket.onWebSocketStatusChanged.trigger(false);
        }

        assert.deepEqual(received, []);
        release.resolve(undefined);
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
    const database = createDatabase(await hash(content));
    const entered = Promise.withResolvers<undefined>(),
        release = Promise.withResolvers<undefined>();
    const websocket = {
        onWebSocketStatusChanged: new EventListeners<
            (connected: boolean) => unknown
        >(),
        onRemoteCursorsUpdateReceived: new EventListeners<
            (cursors: ClientCursors[]) => Promise<void>
        >(),
        updateLocalCursors: () => undefined
    } as unknown as WebSocketManager;
    const tracker = new CursorTracker(
        database,
        websocket,
        {
            read: async () => {
                entered.resolve(undefined);
                await release.promise;
                return { content };
            }
        } as unknown as FileSystemOperations,
        new EventListeners<(path: RelativePath) => unknown>()
    );
    let outdated: boolean | undefined = undefined;
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
    assert.ok(database.state.documents.document);
    database.state.documents.document.base = {
        vaultUpdateId: 2,
        hash: await hash(new TextEncoder().encode("new content"))
    };
    release.resolve(undefined);
    await update;
    assert.equal(outdated, true);
    tracker.reset();
});
