import { logToConsole } from "./utils/debugging/log-to-console";
import { slowFetchFactory } from "./utils/debugging/slow-fetch-factory";
import { slowWebSocketFactory } from "./utils/debugging/slow-web-socket-factory";
import { getRandomColor } from "./utils/get-random-color";
import { lineAndColumnToPosition } from "./utils/line-and-column-to-position";
import { positionToLineAndColumn } from "./utils/position-to-line-and-column";

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
export type { RelativePath, StoredDatabase } from "./persistence/database";
export type { FileSystemOperations } from "./file-operations/filesystem-operations";
export type { PersistenceProvider } from "./persistence/persistence";
export type { CursorSpan } from "./services/types/CursorSpan";
export type { ClientCursors } from "./services/types/ClientCursors";
export type { NetworkConnectionStatus } from "./types/network-connection-status";
export type { ServerVersionMismatchError } from "./services/server-version-mismatch-error";
export type { AuthenticationError } from "./services/authentication-error";
export type { MaybeOutdatedClientCursors } from "./types/maybe-outdated-client-cursors";
export { DocumentSyncStatus } from "./types/document-sync-status";
export { SyncClient } from "./sync-client";
export type { TextWithCursors, CursorPosition } from "reconcile-text";

export const debugging = {
	slowFetchFactory,
	slowWebSocketFactory,
	logToConsole
};

export const utils = {
	getRandomColor,
	positionToLineAndColumn,
	lineAndColumnToPosition
};
