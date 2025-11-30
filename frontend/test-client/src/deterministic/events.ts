import type { RelativePath } from "sync-client";

/**
 * Base event interface
 */
export interface BaseEvent {
	type: string;
	description?: string;
}

/**
 * File operation events
 */
export interface CreateFileEvent extends BaseEvent {
	type: "create-file";
	clientId: string;
	path: RelativePath;
	content: string;
	immediate?: boolean; // If true, sync immediately; if false, defer until flush
}

export interface UpdateFileEvent extends BaseEvent {
	type: "update-file";
	clientId: string;
	path: RelativePath;
	content: string;
	immediate?: boolean;
}

export interface DeleteFileEvent extends BaseEvent {
	type: "delete-file";
	clientId: string;
	path: RelativePath;
	immediate?: boolean;
}

export interface RenameFileEvent extends BaseEvent {
	type: "rename-file";
	clientId: string;
	oldPath: RelativePath;
	newPath: RelativePath;
	immediate?: boolean;
}

export interface AppendToFileEvent extends BaseEvent {
	type: "append-to-file";
	clientId: string;
	path: RelativePath;
	content: string;
	immediate?: boolean;
}

/**
 * Sync control events
 */
export interface FlushEvent extends BaseEvent {
	type: "flush";
	clientId: string;
}

export interface WaitForSyncEvent extends BaseEvent {
	type: "wait-for-sync";
	clientId?: string; // If undefined, wait for all clients
}

export interface EnableSyncEvent extends BaseEvent {
	type: "enable-sync";
	clientId: string;
}

export interface DisableSyncEvent extends BaseEvent {
	type: "disable-sync";
	clientId: string;
}

/**
 * Timing events
 */
export interface SleepEvent extends BaseEvent {
	type: "sleep";
	milliseconds: number;
}

/**
 * Assertion events
 */
export interface AssertFileExistsEvent extends BaseEvent {
	type: "assert-file-exists";
	clientId: string;
	path: RelativePath;
	shouldExist: boolean;
}

export interface AssertFileContentEvent extends BaseEvent {
	type: "assert-file-content";
	clientId: string;
	path: RelativePath;
	expectedContent: string;
}

export interface AssertFileCountEvent extends BaseEvent {
	type: "assert-file-count";
	clientId: string;
	expectedCount: number;
}

export interface AssertAllClientsConsistentEvent extends BaseEvent {
	type: "assert-all-clients-consistent";
}

export interface AssertClientsConsistentEvent extends BaseEvent {
	type: "assert-clients-consistent";
	clientIds: string[];
}

/**
 * Union type of all events
 */
export type TestEvent =
	| CreateFileEvent
	| UpdateFileEvent
	| DeleteFileEvent
	| RenameFileEvent
	| AppendToFileEvent
	| FlushEvent
	| WaitForSyncEvent
	| EnableSyncEvent
	| DisableSyncEvent
	| SleepEvent
	| AssertFileExistsEvent
	| AssertFileContentEvent
	| AssertFileCountEvent
	| AssertAllClientsConsistentEvent
	| AssertClientsConsistentEvent;

/**
 * Test definition
 */
export interface TestDefinition {
	name: string;
	clients: string[]; // Client IDs
	events: TestEvent[];
}
