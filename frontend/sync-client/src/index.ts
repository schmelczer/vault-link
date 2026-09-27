import { awaitAll } from "./utils/await-all";
import { logToConsole } from "./utils/debugging/log-to-console";
import { slowFetchFactory } from "./utils/debugging/slow-fetch-factory";
import { slowWebSocketFactory } from "./utils/debugging/slow-web-socket-factory";
import { getRandomColor } from "./utils/get-random-color";
import { lineAndColumnToPosition } from "./utils/line-and-column-to-position";
import { positionToLineAndColumn } from "./utils/position-to-line-and-column";
import { removeFromArray } from "./utils/remove-from-array";

export {
    SyncType,
    SyncStatus,
    type HistoryStats,
    type HistoryEntry,
    type SyncDetails,
    type SyncCreateDetails,
    type SyncUpdateDetails,
    type SyncMovedDetails,
    type SyncDeleteDetails
} from "./tracing/sync-history";
export { Logger, LogLevel, LogLine } from "./tracing/logger";
export { type SyncSettings, DEFAULT_SETTINGS } from "./persistence/settings";
export { rateLimit } from "./utils/rate-limit";
export type {
    DocumentId,
    RelativePath,
    StoredDatabase,
    VaultUpdateId
} from "./persistence/database";
export type { FileSystemOperations } from "./file-operations/filesystem-operations";
export type { FileSnapshot } from "./snapshot";
export type { MetadataPersistenceProvider as PersistenceProvider } from "./persistence/metadata-persistence-provider";
export type { CursorSpan } from "./services/types/CursorSpan";
export type { ClientCursors } from "./services/types/ClientCursors";
export type { NetworkConnectionStatus } from "./types/network-connection-status";
export type {
    ServerVersionMismatchError,
    AuthenticationError
} from "./errors/errors";
export type { MaybeOutdatedClientCursors } from "./types/maybe-outdated-client-cursors";
export { DocumentSyncStatus } from "./types/document-sync-status";
export { SyncClient, type StoredClient } from "./sync-client";
export type { TextWithCursors, CursorPosition } from "reconcile-text";

export const debugging = {
    slowFetchFactory,
    slowWebSocketFactory,
    logToConsole
};

export const utils = {
    getRandomColor,
    positionToLineAndColumn,
    lineAndColumnToPosition,
    awaitAll,
    removeFromArray
};

export type { EventBatch } from "./services/types/EventBatch";
export type { EventRecord } from "./services/types/EventRecord";
export type { FileManifest } from "./services/types/FileManifest";
export type { PushFileManifest } from "./services/types/PushFileManifest";
export type { PutFileContent } from "./services/types/PutFileContent";
export type { VaultSnapshot } from "./services/types/VaultSnapshot";
export type { FileManifestEntries } from "./types/file-manifest-entries";
