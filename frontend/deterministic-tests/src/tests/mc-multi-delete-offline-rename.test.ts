import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyState(state: ClientState): void {
    const files = Array.from(state.files.keys());

    // file-1.md, file-3.md, file-5.md must survive (unaffected by conflict)
    for (const path of ["file-1.md", "file-3.md", "file-5.md"]) {
        assert(
            state.files.has(path),
            `Expected ${path} to exist. Files: ${files.join(", ")}`
        );
    }

    // file-2.md was deleted on server by Client 1, and renamed to
    // renamed.md by Client 0 offline. The delete should win.
    assert(
        !state.files.has("file-2.md"),
        `Expected file-2.md to be deleted. Files: ${files.join(", ")}`
    );

    // file-4.md was also deleted by Client 1.
    assert(
        !state.files.has("file-4.md"),
        `Expected file-4.md to be deleted. Files: ${files.join(", ")}`
    );

    // renamed.md: Client 0's offline rename of deleted file-2.md.
    // The delete is authoritative, so renamed.md may or may not exist
    // depending on conflict resolution. If it exists, verify its content.
    if (state.files.has("renamed.md")) {
        assert(
            state.files.get("renamed.md") === "content-2",
            `If renamed.md exists, it should have "content-2", got: "${state.files.get("renamed.md")}"`
        );
    }
}

export const mcMultiDeleteOfflineRenameTest: TestDefinition = {
    name: "MC: Multi-File Delete + Offline Rename",
    description:
        "Client 0 creates 5 files. Client 1 deletes 2 while Client 0 (offline) " +
        "renames one of the deleted files. Both must converge.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "file-1.md", content: "content-1" },
        { type: "create", client: 0, path: "file-2.md", content: "content-2" },
        { type: "create", client: 0, path: "file-3.md", content: "content-3" },
        { type: "create", client: 0, path: "file-4.md", content: "content-4" },
        { type: "create", client: 0, path: "file-5.md", content: "content-5" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 goes offline
        { type: "disable-sync", client: 0 },

        // Client 1 deletes file-2 and file-4
        { type: "delete", client: 1, path: "file-2.md" },
        { type: "delete", client: 1, path: "file-4.md" },
        { type: "sync", client: 1 },

        // Client 0 (offline) renames file-2
        { type: "rename", client: 0, oldPath: "file-2.md", newPath: "renamed.md" },

        // Client 0 reconnects
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Both must converge
        { type: "assert-consistent", verify: verifyState }
    ]
};
