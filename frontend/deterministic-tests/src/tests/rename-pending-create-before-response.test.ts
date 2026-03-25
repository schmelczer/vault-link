import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG: Renaming a file while its create request is in-flight orphans the document.
 *
 * Scenario:
 * 1. Client 0 creates `doc.md` (pending create, HTTP request in-flight)
 * 2. Server is paused so the create stalls
 * 3. Client 0 renames `doc.md` → `renamed.md` before the response
 * 4. VFS.move() updates the pending document's path to `renamed.md`
 * 5. Server resumes, create response confirms document at `doc.md`
 * 6. The sync executor may fail to reconcile because the VFS no longer
 *    has a document at `doc.md` — it was moved to `renamed.md`
 *
 * Expected: the file should end up at `renamed.md` on both clients.
 * The server document at `doc.md` should be renamed to `renamed.md`
 * via a follow-up sync operation.
 */
function verifyFileAtRenamedPath(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("renamed.md"),
        `Expected renamed.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const content = state.files.get("renamed.md") ?? "";
    assert(
        content === "original-content",
        `Expected "original-content", got: "${content}"`
    );
}

export const renamePendingCreateBeforeResponseTest: TestDefinition = {
    name: "Rename Pending Create Before Server Response",
    description:
        "When a file is renamed while its create request is in-flight, " +
        "the document must not become orphaned. Both clients should " +
        "converge with the file at the renamed path.",
    clients: 2,
    steps: [
        // Both clients online
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Pause server so the create stalls
        { type: "pause-server" },

        // Client 0 creates doc.md (request stalls at server)
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "original-content"
        },

        // Wait for the create to enter the executor

        // Client 0 renames the file WHILE create is in-flight
        {
            type: "rename",
            client: 0,
            oldPath: "doc.md",
            newPath: "renamed.md"
        },

        // Resume server — create response arrives for "doc.md"
        { type: "resume-server" },

        // Give time for create response + follow-up rename sync
        { type: "sync" },
        { type: "sync" },
        { type: "barrier" },

        // File should be at renamed.md on both clients
        { type: "assert-consistent", verify: verifyFileAtRenamedPath }
    ]
};
