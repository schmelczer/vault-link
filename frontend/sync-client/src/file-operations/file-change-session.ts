import type {
    DocumentId,
    RelativePath,
    StoredDatabase
} from "../persistence/database";
import type { LocalChangeCheckpoint } from "../sync-operations/local-change-checkpoint";
import {
    applyLocalChange,
    getUnappliedChanges,
    type LocalChange
} from "../sync-operations/local-changes";
import type { FileWrite } from "./file-operations";

export interface LocalChangeJournal {
    readonly entries: readonly LocalChange[];
    flush: () => Promise<void>;
}

interface FileChangeSessionOptions {
    current: StoredDatabase;
    planned: StoredDatabase;
    writes: Partial<Record<DocumentId, FileWrite>>;
    localChanges: LocalChangeJournal;
    checkpoint: LocalChangeCheckpoint;
    isProtectedPath: (path: RelativePath) => boolean;
}

/**
 * Coordinates one FileOperations.applyChanges call with FileRenamer, tracking the
 * working and planned identity maps, content writes, and affected paths. Local
 * identity notifications invalidate the plan before the first file mutation;
 * afterward, they are replayed into both maps so in-progress changes can finish
 * consistently. The caller applies filesystem operations and commits the planned
 * metadata; the session does not provide rollback.
 */
export class FileChangeSession {
    public readonly current: StoredDatabase;
    public readonly planned: StoredDatabase;

    public readonly writes: Partial<Record<DocumentId, FileWrite>>;
    public readonly affectedPaths = new Set<RelativePath>();
    private mutationsStarted = false;

    public constructor(private readonly options: FileChangeSessionOptions) {
        this.current = options.current;
        this.planned = options.planned;
        this.writes = options.writes;
    }

    public abortIfStale(): void {
        if (this.mutationsStarted) {
            return;
        }

        this.options.assertUnchanged();
    }

    public beforeFileMutation(): void {
        this.abortIfStale();
        this.mutationsStarted = true;
    }

    public async replayLocalChanges(): Promise<void> {
        const { localChanges, isProtectedPath } = this.options;
        await localChanges.flush();

        if (!this.mutationsStarted) {
            this.options.assertUnchanged();
        }

        for (const change of getUnappliedChanges(
            this.planned,
            localChanges.entries
        )) {
            for (const state of [this.current, this.planned]) {
                applyLocalChange(state, change, isProtectedPath);
                state.lastAppliedLocalChangeId = change.changeId;
            }
        }
    }
}
