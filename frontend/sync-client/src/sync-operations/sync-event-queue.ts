import type { DocumentId, RelativePath } from "../persistence/database";

export type SyncEvent =
    | { type: "file-create"; path: RelativePath }
    | { type: "local-content-update"; documentId: DocumentId }
    | { type: "remote-content-update"; documentId: DocumentId }
    | { type: "move"; documentId: DocumentId }
    | { type: "delete"; documentId: DocumentId };

export class SyncEventQueue {
    private readonly events: SyncEvent[] = [];

    public get size(): number {
        return this.events.length;
    }

    public clear(): void {
        this.events.length = 0;
    }

    public enqueue(event: SyncEvent): void {
        this.events.push(event);
    }

    public next(): SyncEvent | undefined {
        if (this.events.length === 0) return undefined;

        const first = this.events[0];
        if (first.type === "file-create") {
            this.events.shift();
            return first;
        }

        const { documentId } = first;

        // If there's an eventual delete, discard everything for this document
        const deleteEvent = this.events.find(
            (e) => e.type === "delete" && e.documentId === documentId
        );
        if (deleteEvent) {
            this.removeAllForDocument(documentId);
            return deleteEvent;
        }

        // Coalesce updates: return the last update before the next move for this document.
        // Moves act as barriers since they depend on each other
        const moveIndex = this.events.findIndex(
            (e) => e.type === "move" && e.documentId === documentId
        );
        const boundary = moveIndex === -1 ? this.events.length : moveIndex;

        const updateIndices: number[] = [];
        for (let i = 0; i < boundary; i++) {
            const e = this.events[i];
            if (
                (e.type === "local-content-update" ||
                    e.type === "remote-content-update") &&
                e.documentId === documentId
            ) {
                updateIndices.push(i);
            }
        }

        if (updateIndices.length > 0) {
            const result = this.events[updateIndices[updateIndices.length - 1]];
            for (let i = updateIndices.length - 1; i >= 0; i--) {
                this.events.splice(updateIndices[i], 1);
            }
            return result;
        }

        // First event is a move with no preceding updates
        this.events.shift();
        return first;
    }

    private removeAllForDocument(documentId: DocumentId): void {
        for (let i = this.events.length - 1; i >= 0; i--) {
            const e = this.events[i];
            if (e.type !== "file-create" && e.documentId === documentId) {
                this.events.splice(i, 1);
            }
        }
    }
}
