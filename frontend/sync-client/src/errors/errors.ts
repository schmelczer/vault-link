export class SyncResetError extends Error {
    public constructor() {
        super("SyncClient has been reset, cleaning up");
        this.name = "SyncResetError";
    }
}

export class ServerVersionMismatchError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "ServerVersionMismatchError";
    }
}

export class AuthenticationError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "AuthenticationError";
    }
}

export class ConflictingPathError extends Error {
    public constructor(path: string) {
        super(`Conflicting path: ${path}`);
        this.name = "ConflictingPathError";
    }
}

export class PermanentSyncError extends Error {}

/**
 * Retry reconciliation against fresh local state. Raised for stale identity plans
 * and local files that change during history recovery. Syncer schedules another
 * pass without reporting this as a sync failure.
 */
export class LocalChangesDuringReconciliation extends Error {}

// The server rejected a checkpoint from a discarded/restored history.
export class ServerHistoryChangedError extends Error {}
