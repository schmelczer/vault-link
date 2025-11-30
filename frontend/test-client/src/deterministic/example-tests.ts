import type { TestDefinition } from "./events";

/**
 * Simple test: Create a file on one client and verify it syncs to another
 */
export const simpleSync: TestDefinition = {
	name: "Simple sync between two clients",
	clients: ["client1", "client2"],
	events: [
		{
			type: "create-file",
			clientId: "client1",
			path: "test.md",
			content: "Hello, world!",
			description: "Client 1 creates a file"
		},
		{
			type: "wait-for-sync",
			description: "Wait for all clients to sync"
		},
		{
			type: "assert-file-exists",
			clientId: "client2",
			path: "test.md",
			shouldExist: true,
			description: "Verify file exists on Client 2"
		},
		{
			type: "assert-file-content",
			clientId: "client2",
			path: "test.md",
			expectedContent: "Hello, world!",
			description: "Verify content matches on Client 2"
		},
		{
			type: "assert-all-clients-consistent",
			description: "Verify all clients are consistent"
		}
	]
};

/**
 * Test concurrent edits to the same file
 */
export const concurrentEdits: TestDefinition = {
	name: "Concurrent edits with operational transformation",
	clients: ["client1", "client2"],
	events: [
		{
			type: "create-file",
			clientId: "client1",
			path: "collaborative.md",
			content: "Initial content ",
			description: "Client 1 creates initial file"
		},
		{
			type: "wait-for-sync",
			description: "Wait for sync"
		},
		{
			type: "disable-sync",
			clientId: "client1",
			description: "Disable sync on Client 1"
		},
		{
			type: "disable-sync",
			clientId: "client2",
			description: "Disable sync on Client 2"
		},
		{
			type: "append-to-file",
			clientId: "client1",
			path: "collaborative.md",
			content: "EditA ",
			description: "Client 1 appends offline"
		},
		{
			type: "append-to-file",
			clientId: "client2",
			path: "collaborative.md",
			content: "EditB ",
			description: "Client 2 appends offline"
		},
		{
			type: "enable-sync",
			clientId: "client1",
			description: "Re-enable sync on Client 1"
		},
		{
			type: "enable-sync",
			clientId: "client2",
			description: "Re-enable sync on Client 2"
		},
		{
			type: "wait-for-sync",
			description: "Wait for conflict resolution"
		},
		{
			type: "assert-all-clients-consistent",
			description: "Verify both clients converged to same state"
		}
	]
};

/**
 * Test file deletion propagation
 */
export const fileDeletion: TestDefinition = {
	name: "File deletion syncs correctly",
	clients: ["client1", "client2"],
	events: [
		{
			type: "create-file",
			clientId: "client1",
			path: "to-delete.md",
			content: "This file will be deleted",
			description: "Client 1 creates a file"
		},
		{
			type: "wait-for-sync",
			description: "Wait for sync"
		},
		{
			type: "assert-file-exists",
			clientId: "client2",
			path: "to-delete.md",
			shouldExist: true,
			description: "Verify file exists on Client 2"
		},
		{
			type: "delete-file",
			clientId: "client1",
			path: "to-delete.md",
			description: "Client 1 deletes the file"
		},
		{
			type: "wait-for-sync",
			description: "Wait for deletion to sync"
		},
		{
			type: "assert-file-exists",
			clientId: "client2",
			path: "to-delete.md",
			shouldExist: false,
			description: "Verify file deleted on Client 2"
		},
		{
			type: "assert-all-clients-consistent",
			description: "Verify all clients are consistent"
		}
	]
};

/**
 * Test file rename propagation
 */
export const fileRename: TestDefinition = {
	name: "File rename syncs correctly",
	clients: ["client1", "client2"],
	events: [
		{
			type: "create-file",
			clientId: "client1",
			path: "old-name.md",
			content: "Content that should persist",
			description: "Client 1 creates a file"
		},
		{
			type: "wait-for-sync",
			description: "Wait for sync"
		},
		{
			type: "assert-file-exists",
			clientId: "client2",
			path: "old-name.md",
			shouldExist: true,
			description: "Verify file exists on Client 2"
		},
		{
			type: "rename-file",
			clientId: "client1",
			oldPath: "old-name.md",
			newPath: "new-name.md",
			description: "Client 1 renames the file"
		},
		{
			type: "wait-for-sync",
			description: "Wait for rename to sync"
		},
		{
			type: "assert-file-exists",
			clientId: "client2",
			path: "old-name.md",
			shouldExist: false,
			description: "Verify old name doesn't exist on Client 2"
		},
		{
			type: "assert-file-exists",
			clientId: "client2",
			path: "new-name.md",
			shouldExist: true,
			description: "Verify new name exists on Client 2"
		},
		{
			type: "assert-file-content",
			clientId: "client2",
			path: "new-name.md",
			expectedContent: "Content that should persist",
			description: "Verify content preserved"
		},
		{
			type: "assert-all-clients-consistent",
			description: "Verify all clients are consistent"
		}
	]
};

/**
 * Test deferred operations (batching)
 */
export const deferredOperations: TestDefinition = {
	name: "Deferred operations batch correctly",
	clients: ["client1", "client2"],
	events: [
		{
			type: "create-file",
			clientId: "client1",
			path: "file1.md",
			content: "File 1",
			immediate: false,
			description: "Queue creation of file 1 (not synced yet)"
		},
		{
			type: "create-file",
			clientId: "client1",
			path: "file2.md",
			content: "File 2",
			immediate: false,
			description: "Queue creation of file 2 (not synced yet)"
		},
		{
			type: "create-file",
			clientId: "client1",
			path: "file3.md",
			content: "File 3",
			immediate: false,
			description: "Queue creation of file 3 (not synced yet)"
		},
		{
			type: "sleep",
			milliseconds: 100,
			description: "Wait a bit (files shouldn't sync yet)"
		},
		{
			type: "assert-file-count",
			clientId: "client2",
			expectedCount: 0,
			description: "Verify Client 2 has no files yet"
		},
		{
			type: "flush",
			clientId: "client1",
			description: "Flush pending operations on Client 1"
		},
		{
			type: "wait-for-sync",
			description: "Wait for all files to sync"
		},
		{
			type: "assert-file-count",
			clientId: "client2",
			expectedCount: 3,
			description: "Verify Client 2 now has all 3 files"
		},
		{
			type: "assert-all-clients-consistent",
			description: "Verify all clients are consistent"
		}
	]
};

/**
 * Test offline editing and conflict resolution
 */
export const offlineEditing: TestDefinition = {
	name: "Offline editing and reconnection",
	clients: ["client1", "client2"],
	events: [
		{
			type: "create-file",
			clientId: "client1",
			path: "shared.md",
			content: "Initial",
			description: "Client 1 creates initial file"
		},
		{
			type: "wait-for-sync",
			description: "Wait for sync"
		},
		{
			type: "disable-sync",
			clientId: "client2",
			description: "Client 2 goes offline"
		},
		{
			type: "update-file",
			clientId: "client1",
			path: "shared.md",
			content: "Updated by client 1",
			description: "Client 1 updates while Client 2 offline"
		},
		{
			type: "wait-for-sync",
			clientId: "client1",
			description: "Client 1 syncs"
		},
		{
			type: "update-file",
			clientId: "client2",
			path: "shared.md",
			content: "Updated by client 2 offline",
			description: "Client 2 updates while offline"
		},
		{
			type: "enable-sync",
			clientId: "client2",
			description: "Client 2 comes back online"
		},
		{
			type: "wait-for-sync",
			description: "Wait for sync and conflict resolution"
		},
		{
			type: "assert-all-clients-consistent",
			description: "Verify clients converged after reconnection"
		}
	]
};

/**
 * All example tests
 */
export const exampleTests: TestDefinition[] = [
	simpleSync,
	concurrentEdits,
	fileDeletion,
	fileRename,
	deferredOperations,
	offlineEditing
];
