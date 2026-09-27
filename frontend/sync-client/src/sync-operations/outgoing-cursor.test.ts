/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- Test doubles implement only the exercised adapter methods. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { CursorTracker } from "./cursor-tracker";
import { EventListeners } from "../utils/data-structures/event-listeners";
import { hash } from "../utils/hash";
import {
    Database,
    createEmptyDatabase,
    type RelativePath
} from "../persistence/database";
import type { FileSystemOperations } from "../file-operations/filesystem-operations";
import type { WebSocketManager } from "../services/websocket-manager";
import type { DocumentWithCursors } from "../services/types/DocumentWithCursors";

for (const change of ["version", "identity", "path", "delete"] as const) {
    test(`outgoing cursor is dirty when ${change} changes during its snapshot read`, async (): Promise<void> => {
        // Equal bytes deliberately defeat a freshness check that compares only hashes.
        const content = new TextEncoder().encode("same bytes");
        const digest = await hash(content);
        const state = createEmptyDatabase("test");
        state.actualFileManifest.a = "a.md";
        state.documents.a = { base: { vaultUpdateId: 1, hash: digest } };
        const database = new Database(
            state,
            "test",
            async () => undefined,
            async () => undefined
        );
        const sent: { documentsWithCursors: DocumentWithCursors[] }[] = [];
        const websocket = {
            onWebSocketStatusChanged: new EventListeners(),
            onRemoteCursorsUpdateReceived: new EventListeners(),
            updateLocalCursors: (data: {
                documentsWithCursors: DocumentWithCursors[];
            }): number => sent.push(data)
        };
        const files = {
            read: async (): Promise<{ content: Uint8Array }> => {
                const current = database.state;
                assert.ok(current.documents.a?.base);
                assert.ok(current.actualFileManifest.a !== undefined);
                if (change === "delete") {
                    delete current.actualFileManifest.a;
                } else if (change === "version") {
                    current.documents.a.base.vaultUpdateId = 2;
                } else if (change === "identity") {
                    current.actualFileManifest.replacement = current.actualFileManifest.a;
                    current.documents.replacement = current.documents.a;
                    delete current.actualFileManifest.a;
                } else {
                    current.actualFileManifest.a = "moved.md";
                }

                return { content };
            }
        };
        const tracker = new CursorTracker(
            database,
            websocket as unknown as WebSocketManager,
            files as unknown as FileSystemOperations,
            new EventListeners<(path: RelativePath) => unknown>()
        );
        await tracker.sendLocalCursorsToServer({
            "a.md": [{ start: 4, end: 4 }]
        });
        assert.equal(sent.length, 1);
        assert.equal(sent[0]?.documentsWithCursors[0]?.vault_update_id, null);
        tracker.reset();
    });
}
