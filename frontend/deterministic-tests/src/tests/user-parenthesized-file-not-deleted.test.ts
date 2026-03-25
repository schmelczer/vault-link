import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

/**
 * BUG FIX: User-created files with parenthesized names must not be deleted.
 *
 * The duplicate content detection in step 7 of reconciliation uses a regex
 * that matches files like "Chapter (1).md". This should only delete files
 * created by ensureClearPath, not user-intentionally-created files.
 *
 * Note: the two files MUST have different content, because the server
 * merges deconflicted-path creates when the content is identical to the
 * base-path document.
 */
function verifyBothFilesExist(state: ClientState): void {
    assert(
        state.files.size === 2,
        `Expected 2 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("Chapter.md"),
        "Expected Chapter.md to exist"
    );
    assert(
        state.files.has("Chapter (1).md"),
        "Expected Chapter (1).md to exist"
    );
}

export const userParenthesizedFileNotDeletedTest: TestDefinition = {
    name: "User-Created Parenthesized Files Not Deleted",
    description:
        "A user-created file like 'Chapter (1).md' should not be silently " +
        "deleted by the duplicate content detection heuristic. Uses " +
        "different content to avoid server-side deconfliction merge.",
    clients: 2,
    steps: [
        // Client 0 creates both files with DIFFERENT content
        // (same content triggers server-side deconfliction merge)
        {
            type: "create",
            client: 0,
            path: "Chapter.md",
            content: "chapter one"
        },
        {
            type: "create",
            client: 0,
            path: "Chapter (1).md",
            content: "chapter one notes"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both files should survive on both clients
        { type: "assert-consistent", verify: verifyBothFilesExist }
    ]
};
