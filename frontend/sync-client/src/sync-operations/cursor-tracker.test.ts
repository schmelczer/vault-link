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
            isDeleted: false,
            metadata: { parentVersionId: 2, hash: contentHash }
        })
    } as unknown as Database;
    const websocket = {
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
