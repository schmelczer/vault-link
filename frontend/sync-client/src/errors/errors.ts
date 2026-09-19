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

export class FileNotFoundError extends Error {
    public constructor(
        message: string,
        public readonly filePath: string
    ) {
        super(message);
        this.name = "FileNotFoundError";
    }
}

export class PermanentSyncError extends Error { }

export class LocalChangesDuringReconciliation extends Error { }
