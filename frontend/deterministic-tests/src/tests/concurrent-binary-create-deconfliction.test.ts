import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Concurrent binary creates at the same path lose one file.
 *
 * Scenario:
 * 1. Both clients create a binary file at the same path while offline
 * 2. Client 0 syncs first — server creates `data.bin`
 * 3. Client 1 syncs — server deconflicts to `data (1).bin` (binary
 *    files can't be 3-way merged)
 * 4. Client 1 renames its local `data.bin` to `data (1).bin`
 *    (ensureClearPath in FileOperations)
 * 5. Client 1 never downloads client 0's `data.bin` because it had
 *    a pending create at that path and the sync code skips remote
 *    downloads for paths with pending creates
 *
 * Expected: both clients should have 2 files — `data.bin` (client 0's
 * content) and `data (1).bin` (client 1's content).
 *
 * Related: CLAUDE.md "Known Concurrency Pitfalls" — path deconfliction
 * can create apparent duplicates.
 */
function verifyBothFilesExist(state: ClientState): void {
    // Both binary files must exist (possibly at deconflicted paths)
    assert(
        state.files.size === 2,
        `Expected 2 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );

    // Both original contents must be present somewhere
    const allContent = Array.from(state.files.values()).join("\n");
    assert(
        allContent.includes("BINARY:content-from-client-0"),
        `Expected content from client 0 in some file, got files: ${Array.from(state.files.entries()).map(([k, v]) => `${k}=${v}`).join(", ")}`
    );
    assert(
        allContent.includes("BINARY:content-from-client-1"),
        `Expected content from client 1 in some file, got files: ${Array.from(state.files.entries()).map(([k, v]) => `${k}=${v}`).join(", ")}`
    );
}

export const concurrentBinaryCreateDeconflictionTest: TestDefinition = {
    name: "Concurrent Binary Creates Deconflict Without Losing File",
    description:
        "Two clients create a binary file at the same path while offline. " +
        "The server deconflicts one to a (1) path. Both clients must end " +
        "up with both files.",
    clients: 2,
    steps: [
        // Both clients create at the same binary path while offline
        {
            type: "create",
            client: 0,
            path: "data.bin",
            content: "BINARY:content-from-client-0"
        },
        {
            type: "create",
            client: 1,
            path: "data.bin",
            content: "BINARY:content-from-client-1"
        },

        // Client 0 syncs first — server creates data.bin
        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },

        // Client 1 syncs — server deconflicts to data (1).bin
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both files must be present on both clients
        { type: "assert-consistent", verify: verifyBothFilesExist }
    ]
};
