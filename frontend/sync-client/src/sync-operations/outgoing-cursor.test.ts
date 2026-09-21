import assert from "node:assert/strict";
import { test } from "node:test";
import { CursorTracker } from "./cursor-tracker";
import { FileChangeNotifier } from "./file-change-notifier";
import { EventListeners } from "../utils/data-structures/event-listeners";
import { hash } from "../utils/hash";
import type { Database, DocumentRecord } from "../persistence/database";
import type { FileOperations } from "../file-operations/file-operations";
import type { WebSocketManager } from "../services/websocket-manager";
import type { DocumentWithCursors } from "../services/types/DocumentWithCursors";

for (const change of ["version", "identity", "path", "delete"] as const)
    test(`outgoing cursor is dirty when ${change} changes during its snapshot read`, async () => {
        // Equal bytes deliberately defeat a freshness check that compares only hashes.
        const content = new TextEncoder().encode("same bytes");
        const digest = await hash(content);
        let current: DocumentRecord | undefined = {
            documentId: "a",
            relativePath: "a.md",
            metadata: { parentVersionId: 1, hash: digest }
        };
        const sent: { documentsWithCursors: DocumentWithCursors[] }[] = [];
        const websocket = {
            onWebSocketStatusChanged: new EventListeners(),
            onRemoteCursorsUpdateReceived: new EventListeners(),
            updateLocalCursors: (data: {
                documentsWithCursors: DocumentWithCursors[];
            }) => sent.push(data)
        };
        const files = {
            read: async () => {
                if (change === "delete") current = undefined;
                else if (change === "version")
                    current!.metadata!.parentVersionId = 2;
                else if (change === "identity")
                    current!.documentId = "replacement";
                else current!.relativePath = "moved.md";
                return content;
            }
        };
        const tracker = new CursorTracker(
            {
                getDocumentByDocumentId: (id: string) =>
                    current?.documentId === id ? current : undefined,
                getLatestDocumentByRelativePath: (path: string) =>
                    current?.relativePath === path ? current : undefined
            } as unknown as Database,
            websocket as unknown as WebSocketManager,
            files as unknown as FileOperations,
            new FileChangeNotifier()
        );
        await tracker.sendLocalCursorsToServer({
            "a.md": [{ start: 4, end: 4 }]
        });
        assert.equal(sent.length, 1);
        assert.equal(sent[0].documentsWithCursors[0].vault_update_id, null);
        tracker.reset();
    });
