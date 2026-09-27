// Values match the discriminants in the server-generated wire types.
export enum SyncEventType {
    Content = "content",
    FileManifest = "fileManifest"
}

export enum PushContentType {
    Snapshot = "Snapshot",
    Diff = "Diff"
}

export enum UpdateResponseType {
    Accepted = "Accepted",
    StaleBase = "StaleBase"
}

export enum WebSocketMessageType {
    Handshake = "handshake",
    CursorPositions = "cursorPositions",
    VaultChanged = "vaultChanged"
}
