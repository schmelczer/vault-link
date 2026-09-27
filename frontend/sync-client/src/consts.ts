export const TIMEOUT_FOR_MERGING_HISTORY_ENTRIES_IN_SECONDS = 60;
export const MAX_LOG_MESSAGE_COUNT = 100000;
export const MAX_HISTORY_ENTRY_COUNT = 5000;
export const SUPPORTED_API_VERSION = 4;
export const CURSOR_HEARTBEAT_INTERVAL_MS = 15_000;
export const WEBSOCKET_RECEIVE_TIMEOUT_MS = CURSOR_HEARTBEAT_INTERVAL_MS * 3;

export const HISTORY_HEADER = "x-vault-link-history";
export const HISTORY_MISMATCH_HEADER = "x-vault-link-history-mismatch";
