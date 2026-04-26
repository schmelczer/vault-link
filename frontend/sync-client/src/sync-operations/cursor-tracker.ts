import type { FileOperations } from "../file-operations/file-operations";
import type { RelativePath } from "./types";
import type { SyncEventQueue } from "./sync-event-queue";
import type { ClientCursors } from "../services/types/ClientCursors";
import type { CursorSpan } from "../services/types/CursorSpan";
import type { DocumentWithCursors } from "../services/types/DocumentWithCursors";
import type { WebSocketManager } from "../services/websocket-manager";
import type { MaybeOutdatedClientCursors } from "../types/maybe-outdated-client-cursors";
import { DocumentUpToDateness } from "../types/document-up-to-dateness";
import { hash } from "../utils/hash";
import type { FileChangeNotifier } from "./file-change-notifier";
import { Lock } from "../utils/data-structures/locks";
import { EventListeners } from "../utils/data-structures/event-listeners";
import type { Logger } from "../tracing/logger";

// Cursor positions are updated separately from documents. However, a given cursor position is only
// valid within a certain version of the document it belongs to. This class tracks previous and the latest
// known remote cursor positions, and for each document, tries to return the latest cursor positions that are
// not from the future.
export class CursorTracker {
    // The returned position may be accurate, if it matches the document version, or outdated, in which case
    // the client has to heuristically guess it's current position based on the local edits.
    public readonly onRemoteCursorsUpdated = new EventListeners<
        (cursors: MaybeOutdatedClientCursors[]) => unknown
    >();

    private readonly updateLock: Lock;

    private knownRemoteCursors: (ClientCursors & {
        upToDateness: DocumentUpToDateness;
    })[] = [];

    // Cache the previously sent state as a JSON string rather than as the
    // array. We mutate `documentsWithCursors` in-place after the cache check
    // (setting `vaultUpdateId = null` for dirty docs); storing the array would
    // alias and the next call's equality check would compare against
    // post-mutation state.
    private lastLocalCursorStateJson = "[]";
    private lastLocalCursorStateWithoutDirtyDocumentsJson = "[]";

    public constructor(
        logger: Logger,
        private readonly queue: SyncEventQueue,
        private readonly webSocketManager: WebSocketManager,
        private readonly fileOperations: FileOperations,
        private readonly fileChangeNotifier: FileChangeNotifier
    ) {
        this.updateLock = new Lock(CursorTracker.name, logger);

        this.webSocketManager.onRemoteCursorsUpdateReceived.add(
            async (clientCursors) => {
                await this.updateLock.withLock(async () => {
                    // The latest message will contain all active clients, so we can delete the ones
                    // from the local list which are no longer active.
                    const allIds = new Set(
                        clientCursors.map((c) => c.deviceId)
                    );
                    const updatedKnownRemoteCursors =
                        this.knownRemoteCursors.filter((c) =>
                            allIds.has(c.deviceId)
                        );

                    for (const cursor of clientCursors.filter((client) =>
                        client.documentsWithCursors.every(
                            (doc) => doc.vaultUpdateId != null
                        )
                    )) {
                        updatedKnownRemoteCursors.push({
                            ...cursor,
                            upToDateness:
                                await this.getDocumentsUpToDateness(cursor)
                        });
                    }

                    this.knownRemoteCursors = updatedKnownRemoteCursors;
                });

                this.onRemoteCursorsUpdated.trigger(
                    this.getRelevantAndPruneKnownClientCursors()
                );
            }
        );

        this.fileChangeNotifier.onFileChanged.add(async (relativePath) =>
            this.updateLock.withLock(async () => {
                for (const clientCursor of this.knownRemoteCursors) {
                    if (
                        clientCursor.documentsWithCursors.some(
                            (document) => document.relativePath === relativePath
                        )
                    ) {
                        clientCursor.upToDateness =
                            await this.getDocumentsUpToDateness(clientCursor);
                    }
                }
                // Drop the local-cursor send-cache so the next call re-reads
                // the file. The first cache key is the editor's input, which
                // doesn't change when the file content does — without this,
                // a remote update flipping the file from dirty back to clean
                // would never re-send the cursor with a fresh `vaultUpdateId`.
                this.lastLocalCursorStateJson = "";
                this.lastLocalCursorStateWithoutDirtyDocumentsJson = "";
            })
        );
    }

    /// Update the local cursors for the given documents.
    /// Can be called frequently as it only emits an event
    /// if the state has actually changed.
    public async sendLocalCursorsToServer(
        documentToCursors: Record<RelativePath, CursorSpan[]>
    ): Promise<void> {
        // Serialise concurrent senders so they don't interleave on the
        // disk reads + state mutations and emit out-of-order cursor messages.
        await this.updateLock.withLock(async () => {
            const documentsWithCursors: DocumentWithCursors[] = [];

            for (const [relativePath, cursors] of Object.entries(
                documentToCursors
            )) {
                const record = this.queue.getSettledDocumentByPath(relativePath);

                if (!record) {
                    continue; // Let's wait for the file to be created before sending cursors
                }

                documentsWithCursors.push({
                    relativePath: relativePath,
                    documentId: record.documentId,
                    vaultUpdateId: record.parentVersionId,
                    cursors: cursors.map(({ start, end }) => ({
                        start: Math.min(start, end),
                        end: Math.max(start, end)
                    })) // the client might send directional selections
                });
            }

            const beforeJson = JSON.stringify(documentsWithCursors);
            if (this.lastLocalCursorStateJson === beforeJson) {
                // Caching step to avoid reading the edited files all the time
                return;
            }
            this.lastLocalCursorStateJson = beforeJson;

            for (const doc of documentsWithCursors) {
                const readContent = await this.fileOperations.read(
                    doc.relativePath
                );
                const record = this.queue.getSettledDocumentByPath(
                    doc.relativePath
                );
                if (record?.remoteHash !== (await hash(readContent))) {
                    doc.vaultUpdateId = null;
                }
            }

            const afterJson = JSON.stringify(documentsWithCursors);
            if (this.lastLocalCursorStateWithoutDirtyDocumentsJson === afterJson) {
                return;
            }

            this.lastLocalCursorStateWithoutDirtyDocumentsJson = afterJson;

            this.webSocketManager.updateLocalCursors({ documentsWithCursors });
        });
    }

    public reset(): void {
        this.knownRemoteCursors = [];
        this.lastLocalCursorStateJson = "[]";
        this.lastLocalCursorStateWithoutDirtyDocumentsJson = "[]";
        this.updateLock.reset();
    }

    private getRelevantAndPruneKnownClientCursors(): MaybeOutdatedClientCursors[] {
        const result: MaybeOutdatedClientCursors[] = [];
        const included = new Set<string>();

        const relevantCursors = [];
        for (const clientCursors of [...this.knownRemoteCursors].reverse()) {
            if (included.has(clientCursors.deviceId)) {
                continue;
            }

            if (clientCursors.upToDateness === DocumentUpToDateness.Later) {
                continue;
            }

            result.push({
                ...clientCursors,
                isOutdated:
                    clientCursors.upToDateness === DocumentUpToDateness.Prior
            });

            included.add(clientCursors.deviceId);
            relevantCursors.unshift(clientCursors); // to reverse order back to normal
        }

        this.knownRemoteCursors = relevantCursors;

        return result;
    }

    // We store up-to-dateness on a per-client basis to simplify the implementation.
    // An individual client won't have too many documents open at once, so this is a reasonable trade-off.
    private async getDocumentsUpToDateness(
        clientCursor: ClientCursors
    ): Promise<DocumentUpToDateness> {
        const results = [];
        for (const document of clientCursor.documentsWithCursors) {
            results.push(await this.getDocumentUpToDateness(document));
        }

        if (
            results.every((result) => result === DocumentUpToDateness.UpToDate)
        ) {
            return DocumentUpToDateness.UpToDate;
        }

        if (
            results.every(
                (result) =>
                    result === DocumentUpToDateness.UpToDate ||
                    result === DocumentUpToDateness.Prior
            )
        ) {
            return DocumentUpToDateness.Prior;
        }

        return DocumentUpToDateness.Later;
    }

    private async getDocumentUpToDateness(
        document: DocumentWithCursors
    ): Promise<DocumentUpToDateness> {
        const record = this.queue.getSettledDocumentByPath(
            document.relativePath
        );

        if (!record) {
            // the document of the cursor must be from the future
            return DocumentUpToDateness.Later;
        }

        if (record.parentVersionId < (document.vaultUpdateId ?? 0)) {
            return DocumentUpToDateness.Later;
        } else if ((document.vaultUpdateId ?? 0) < record.parentVersionId) {
            // the document of the cursor must be from the past
            return DocumentUpToDateness.Prior;
        }

        const currentContent = await this.fileOperations.read(
            document.relativePath
        );

        const currentRecord = this.queue.getSettledDocumentByPath(
            document.relativePath
        );
        return currentRecord?.remoteHash === (await hash(currentContent))
            ? DocumentUpToDateness.UpToDate
            : DocumentUpToDateness.Prior;
    }
}
