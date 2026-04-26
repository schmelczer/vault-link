import {
    MAX_HISTORY_ENTRY_COUNT,
    TIMEOUT_FOR_MERGING_HISTORY_ENTRIES_IN_SECONDS
} from "../consts";
import type { RelativePath } from "../sync-operations/types";
import type { Logger } from "./logger";
import { removeFromArray } from "../utils/remove-from-array";
import { EventListeners } from "../utils/data-structures/event-listeners";

export interface SyncCreateDetails {
    type: SyncType.CREATE;
    relativePath: RelativePath;
}

export interface SyncUpdateDetails {
    type: SyncType.UPDATE;
    relativePath: RelativePath;
}

export interface SyncMovedDetails {
    type: SyncType.MOVE;
    relativePath: RelativePath;
    movedFrom: RelativePath;
}

export interface SyncDeleteDetails {
    type: SyncType.DELETE;
    relativePath: RelativePath;
}

interface SyncSkippedDetails {
    type: SyncType.SKIPPED;
    relativePath: RelativePath;
}

export type SyncDetails =
    | SyncCreateDetails
    | SyncUpdateDetails
    | SyncDeleteDetails
    | SyncMovedDetails
    | SyncSkippedDetails;

export interface HistoryEntry {
    status: SyncStatus;
    message: string;
    details: SyncDetails;
    timestamp: Date;
    // `author` is the server-side user id and only exists for entries that
    // round-tripped through the server. Local-only entries (e.g. SKIPPED)
    // legitimately have no author.
    author?: string;
}

export enum SyncType {
    CREATE = "CREATE",
    UPDATE = "UPDATE",
    DELETE = "DELETE",
    MOVE = "MOVE",
    SKIPPED = "SKIPPED"
}

export enum SyncStatus {
    SUCCESS = "SUCCESS",
    ERROR = "ERROR",
    SKIPPED = "SKIPPED"
}


export interface HistoryStats {
    success: number;
    error: number;
}

export class SyncHistory {
    public readonly onHistoryUpdated = new EventListeners<
        (status: HistoryStats) => unknown
    >();

    private readonly _entries: HistoryEntry[] = [];

    private status: HistoryStats = {
        success: 0,
        error: 0
    };

    public constructor(private readonly logger: Logger) { }

    public get entries(): readonly HistoryEntry[] {
        return this._entries;
    }

    /**
     * Insert the entry at the beginning of the history list. If the entry
     * already in the list, it will get moved to the beginning and updated.
     *
     * If the entry list is too long, the oldest entry will be removed.
     */
    public addHistoryEntry(entry: HistoryEntry): void {
        const candidate = this.findSimilarRecentUpdateEntry(entry);
        if (candidate !== undefined) {
            removeFromArray(this._entries, candidate);
        }

        // Insert the entry at the beginning
        this._entries.unshift(entry);

        if (this._entries.length > MAX_HISTORY_ENTRY_COUNT) {
            this._entries.pop();
        }

        this.updateSuccessCount(entry);
    }

    public reset(): void {
        this._entries.length = 0;
        this.status = {
            success: 0,
            error: 0
        };
        this.onHistoryUpdated.trigger(this.status);
    }

    private findSimilarRecentUpdateEntry(
        entry: HistoryEntry
    ): HistoryEntry | undefined {
        if (entry.details.type !== SyncType.UPDATE) {
            return;
        }

        const candidate = this._entries.find(
            (e) =>
                e.details.type === SyncType.UPDATE &&
                e.details.relativePath === entry.details.relativePath
        );
        if (
            candidate !== undefined &&
            (this._entries[0] === candidate ||
                candidate.timestamp.getTime() +
                TIMEOUT_FOR_MERGING_HISTORY_ENTRIES_IN_SECONDS * 1000 >
                entry.timestamp.getTime())
        ) {
            return candidate;
        }
    }

    private updateSuccessCount(entry: HistoryEntry): void {
        const message = `${entry.details.relativePath} - ${entry.message} (${entry.details.type.toLocaleLowerCase()})`;
        switch (entry.status) {
            case SyncStatus.SUCCESS:
                this.status.success++;
                this.logger.info(`History entry: ${message}`);
                break;
            case SyncStatus.ERROR:
                this.status.error++;
                this.logger.error(`Cannot sync file: ${message}`);
                break;
            case SyncStatus.SKIPPED:
                this.logger.warn(`Skipping file: ${message}`);
                break;
        }

        this.onHistoryUpdated.trigger(this.status);
    }
}
