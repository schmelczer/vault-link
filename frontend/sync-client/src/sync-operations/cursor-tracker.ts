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

    private knownRemoteCursors: (ClientCursors & {
        upToDateness: DocumentUpToDateness;
    })[] = [];

    private lastLocalCursorState: DocumentWithCursors[] = [];
    private lastLocalCursorStateWithoutDirtyDocuments: DocumentWithCursors[] =
        [];

    public constructor(
        private readonly database: Database,
        private readonly webSocketManager: WebSocketManager,
        private readonly fileOperations: FileOperations,
        private readonly fileChangeNotifier: FileChangeNotifier
    ) {
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
                            (doc) => doc.vault_update_id != null
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
                            (document) =>
                                document.relative_path === relativePath
                        )
                    ) {
                        clientCursor.upToDateness =
                            await this.getDocumentsUpToDateness(clientCursor);
                    }
                }
            })
        );
    }

    /// Update the local cursors for the given documents.
    /// Can be called frequently as it only emits an event
    /// if the state has actually changed.
    public async sendLocalCursorsToServer(
        documentToCursors: Record<RelativePath, CursorSpan[]>
    ): Promise<void> {
        const documentsWithCursors: DocumentWithCursors[] = [];

        for (const [relativePath, cursors] of Object.entries(
            documentToCursors
        )) {
            const record =
                this.database.getLatestDocumentByRelativePath(relativePath);

            if (!record) {
                continue; // Let's wait for the file to be created before sending cursors
            }

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
            JSON.stringify(this.lastLocalCursorState) ===
            JSON.stringify(documentsWithCursors)
        ) {
            // Caching step to avoid reading the edited files all the time
            return;
        }
        this.lastLocalCursorState = documentsWithCursors;

        for (const doc of documentsWithCursors) {
            const readContent = await this.fileOperations.read(
                doc.relative_path
            );
            const record = this.database.getLatestDocumentByRelativePath(
                doc.relative_path
            );
            if (record?.metadata?.hash !== (await hash(readContent))) {
                doc.vault_update_id = null;
            }
        }

        if (
            JSON.stringify(this.lastLocalCursorStateWithoutDirtyDocuments) ===
            JSON.stringify(documentsWithCursors)
        ) {
            return;
        }

        this.lastLocalCursorStateWithoutDirtyDocuments = documentsWithCursors;

        this.webSocketManager.updateLocalCursors({ documentsWithCursors });
    }

    public reset(): void {
        this.knownRemoteCursors = [];
        this.lastLocalCursorState = [];
        this.lastLocalCursorStateWithoutDirtyDocuments = [];
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
        const record = this.database.getDocumentByDocumentId(
            document.document_id
        );

        if (!record) {
            // the document of the cursor must be from the future
            return DocumentUpToDateness.Later;
        }

        if (
            (record.metadata?.parentVersionId ?? 0) <
            (document.vault_update_id ?? 0)
        ) {
            return DocumentUpToDateness.Later;
        } else if (
            (document.vault_update_id ?? 0) <
            (record.metadata?.parentVersionId ?? 0)
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

        return record.metadata?.hash === (await hash(currentContent))
            ? DocumentUpToDateness.UpToDate
            : DocumentUpToDateness.Prior;
    }
}
