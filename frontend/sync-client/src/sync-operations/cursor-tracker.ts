import type { FileOperations } from "../file-operations/file-operations";
import type { Database, RelativePath } from "../persistence/database";
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

    private readonly updateLock = new Lock();
    private sessionGeneration = 0;

    private knownRemoteCursors: (ClientCursors & {
        upToDateness: DocumentUpToDateness;
    })[] = [];

    private lastLocalCursorState: DocumentWithCursors[] = [];
    private lastLocalCursorStateWithoutDirtyDocuments: DocumentWithCursors[] =
        [];
    private localCursors: Record<string, CursorSpan[]> = {};
    private localCursorDocuments: Record<string, string> = {};
    private cursorTimer?: ReturnType<typeof setInterval>;
    private readonly sendLock = new Lock();

    public constructor(
        private readonly database: Database,
        private readonly webSocketManager: WebSocketManager,
        private readonly fileOperations: FileOperations,
        private readonly fileChangeNotifier: FileChangeNotifier
    ) {
        this.webSocketManager.onWebSocketStatusChanged.add((connected) => {
            this.sessionGeneration++;
            clearInterval(this.cursorTimer);
            this.lastLocalCursorState = [];
            this.lastLocalCursorStateWithoutDirtyDocuments = [];
            if (!connected) {
                this.knownRemoteCursors = [];
                this.onRemoteCursorsUpdated.trigger([]);
                return;
            }
            const refresh = () => {
                void this.publishLocalCursors(true).catch(() => {
                    // A concurrent move/deletion can invalidate an editor view;
                    // the next notification or heartbeat retries the snapshot.
                });
            };
            refresh();
            this.cursorTimer = setInterval(refresh, 15_000);
            this.cursorTimer.unref?.();
        });
        this.webSocketManager.onRemoteCursorsUpdateReceived.add(
            async (clientCursors) => {
                const generation = this.sessionGeneration;
                await this.updateLock.withLock(async () => {
                    if (generation !== this.sessionGeneration) return;
                    // The latest message will contain all active clients, so we can delete the ones
                    // from the local list which are no longer active.
                    const allIds = new Set(
                        clientCursors.map((c) => c.deviceId)
                    );
                    const updatedKnownRemoteCursors =
                        this.knownRemoteCursors.filter((c) =>
                            allIds.has(c.deviceId)
                        );

                    for (const cursor of clientCursors) {
                        updatedKnownRemoteCursors.push({
                            ...cursor,
                            upToDateness:
                                await this.getDocumentsUpToDateness(cursor)
                        });
                    }

                    if (generation !== this.sessionGeneration) return;
                    this.knownRemoteCursors = updatedKnownRemoteCursors;
                    this.onRemoteCursorsUpdated.trigger(
                        this.getRelevantAndPruneKnownClientCursors()
                    );
                });
            }
        );

        this.fileChangeNotifier.onFileChanged.add(async (relativePath) => {
            const generation = this.sessionGeneration;
            await this.publishLocalCursors(true);
            const cursors = await this.updateLock.withLock(async () => {
                if (generation !== this.sessionGeneration) return [];
                for (const clientCursor of this.knownRemoteCursors) {
                    if (
                        clientCursor.documentsWithCursors.some(
                            (document) =>
                                document.relative_path === relativePath ||
                                this.database.getDocumentByDocumentId(
                                    document.document_id
                                )?.relativePath === relativePath
                        )
                    ) {
                        clientCursor.upToDateness =
                            await this.getDocumentsUpToDateness(clientCursor);
                    }
                }
                return generation === this.sessionGeneration
                    ? this.getRelevantAndPruneKnownClientCursors()
                    : [];
            });

            if (generation === this.sessionGeneration)
                this.onRemoteCursorsUpdated.trigger(cursors);
        });
    }

    /// Update the local cursors for the given documents.
    /// Can be called frequently as it only emits an event
    /// if the state has actually changed.
    public async sendLocalCursorsToServer(
        documentToCursors: Record<RelativePath, CursorSpan[]>
    ): Promise<void> {
        this.localCursors = structuredClone(documentToCursors);
        this.localCursorDocuments = {};
        await this.publishLocalCursors(false);
    }

    private async publishLocalCursors(force: boolean): Promise<void> {
        const generation = this.sessionGeneration;
        await this.sendLock.withLock(async () => {
            if (generation !== this.sessionGeneration) return;
            const documentsWithCursors: DocumentWithCursors[] = [];

            for (const [editorPath, cursors] of Object.entries(
                this.localCursors
            )) {
                const id = this.localCursorDocuments[editorPath];
                const record = id
                    ? this.database.getDocumentByDocumentId(id)
                    : this.database.getLatestDocumentByRelativePath(editorPath);

                if (!record) {
                    continue; // Let's wait for the file to be created before sending cursors
                }
                this.localCursorDocuments[editorPath] = record.documentId;
                const { relativePath } = record;

                if (!record.metadata) {
                    continue; // this is a new document, no need to sync the cursors
                }

                documentsWithCursors.push({
                    relative_path: relativePath,
                    document_id: record.documentId,
                    vault_update_id: record.metadata.parentVersionId,
                    cursors: cursors.map(({ start, end }) => ({
                        start: Math.min(start, end),
                        end: Math.max(start, end)
                    })) // the client might send directional selections
                });
            }

            if (
                !force &&
                JSON.stringify(this.lastLocalCursorState) ===
                    JSON.stringify(documentsWithCursors)
            ) {
                // Caching step to avoid reading the edited files all the time
                return;
            }
            this.lastLocalCursorState = structuredClone(documentsWithCursors);

            for (const doc of documentsWithCursors) {
                let readContent: Uint8Array;
                try {
                    readContent = await this.fileOperations.read(
                        doc.relative_path
                    );
                } catch {
                    doc.vault_update_id = null;
                    continue;
                }
                const digest = await hash(readContent);
                const record = this.database.getLatestDocumentByRelativePath(
                    doc.relative_path
                );
                if (
                    record?.documentId !== doc.document_id ||
                    record.relativePath !== doc.relative_path ||
                    record.metadata?.parentVersionId !== doc.vault_update_id ||
                    record.metadata.hash !== digest
                ) {
                    doc.vault_update_id = null;
                }
            }

            if (generation !== this.sessionGeneration) return;
            if (
                !force &&
                JSON.stringify(
                    this.lastLocalCursorStateWithoutDirtyDocuments
                ) === JSON.stringify(documentsWithCursors)
            ) {
                return;
            }

            this.lastLocalCursorStateWithoutDirtyDocuments =
                documentsWithCursors;

            this.webSocketManager.updateLocalCursors({ documentsWithCursors });
        });
    }

    public reset(): void {
        this.sessionGeneration++;
        clearInterval(this.cursorTimer);
        this.knownRemoteCursors = [];
        this.onRemoteCursorsUpdated.trigger([]);
        this.lastLocalCursorState = [];
        this.lastLocalCursorStateWithoutDirtyDocuments = [];
        // Keep serialization intact while old reads drain. A generation fence
        // discards both active and queued work from the retired connection.
    }

    private getRelevantAndPruneKnownClientCursors(): MaybeOutdatedClientCursors[] {
        const result: MaybeOutdatedClientCursors[] = [];
        const included = new Set<string>();

        const retainedCursors = [];
        const retainedFuture = new Set<string>();
        for (const clientCursors of [...this.knownRemoteCursors].reverse()) {
            if (clientCursors.upToDateness === DocumentUpToDateness.Later) {
                // Retain the latest future position so it can become relevant
                // after the corresponding content or manifest is applied.
                if (!retainedFuture.has(clientCursors.deviceId)) {
                    retainedCursors.unshift(clientCursors);
                    retainedFuture.add(clientCursors.deviceId);
                }
                continue;
            }

            if (included.has(clientCursors.deviceId)) {
                continue;
            }

            result.push({
                ...clientCursors,
                documentsWithCursors: clientCursors.documentsWithCursors.map(
                    (document) => ({
                        ...document,
                        relative_path:
                            this.database.getDocumentByDocumentId(
                                document.document_id
                            )?.relativePath ?? document.relative_path
                    })
                ),
                isOutdated:
                    clientCursors.upToDateness === DocumentUpToDateness.Prior
            });

            included.add(clientCursors.deviceId);
            retainedCursors.unshift(clientCursors); // to reverse order back to normal
        }

        this.knownRemoteCursors = retainedCursors;

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
        if (document.vault_update_id === null)
            return DocumentUpToDateness.Prior;
        const record = this.database.getDocumentByDocumentId(
            document.document_id
        );

        if (!record) {
            // the document of the cursor must be from the future
            return DocumentUpToDateness.Later;
        }

        if (
            (record.metadata?.parentVersionId ?? 0) < document.vault_update_id
        ) {
            return DocumentUpToDateness.Later;
        } else if (
            document.vault_update_id < (record.metadata?.parentVersionId ?? 0)
        ) {
            // the document of the cursor must be from the past
            return DocumentUpToDateness.Prior;
        }

        let currentContent: Uint8Array;
        try {
            currentContent = await this.fileOperations.read(
                record.relativePath
            );
        } catch {
            return DocumentUpToDateness.Prior;
        }

        const contentHash = await hash(currentContent);
        const current = this.database.getDocumentByDocumentId(
            document.document_id
        );
        return current?.metadata?.parentVersionId ===
            document.vault_update_id &&
            current.relativePath === record.relativePath &&
            current.metadata.hash === contentHash
            ? DocumentUpToDateness.UpToDate
            : DocumentUpToDateness.Prior;
    }
}
