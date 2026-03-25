import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyThreeFiles(state: ClientState): void {
    const files = Array.from(state.files.keys()).sort();
    assert(
        state.files.size === 3,
        `Expected 3 files, got ${state.files.size}: ${files.join(", ")}`
    );
    assert(
        state.files.has("B.md"),
        `Expected B.md (first file renamed), got: ${files.join(", ")}`
    );
    assert(
        state.files.has("C.md"),
        `Expected C.md (second file renamed), got: ${files.join(", ")}`
    );
    assert(
        state.files.has("A.md"),
        `Expected A.md (third file still at original path), got: ${files.join(", ")}`
    );

    const bContent = state.files.get("B.md") ?? "";
    const cContent = state.files.get("C.md") ?? "";
    const aContent = state.files.get("A.md") ?? "";
    assert(
        bContent === "first file",
        `Expected B.md to contain "first file", got: "${bContent}"`
    );
    assert(
        cContent === "second file",
        `Expected C.md to contain "second file", got: "${cContent}"`
    );
    assert(
        aContent === "third file",
        `Expected A.md to contain "third file", got: "${aContent}"`
    );
}

/**
 * BUG: Tests the queue key migration for pending creates. When a file
 * is created at path A, then renamed to B (freeing path A), then a new
 * file is created at A, the event coalescing must migrate the first
 * create's key from "path:A" to "path:B" so the second create doesn't
 * coalesce with the first.
 *
 * Without key migration (lines 54-68 in sync-event-queue.ts), the
 * second create at "path:A" would find the first create's state and
 * coalesce with it, losing the second file.
 */
export const createRenameCreateSamePathTest: TestDefinition = {
    name: "Create-Rename-Create at Same Path (Three Files)",
    description:
        "Client creates A.md, renames to B.md, creates new A.md, renames " +
        "to C.md, creates yet another A.md. All three files should exist " +
        "as separate documents. Tests queue key migration when pending " +
        "creates are renamed before sync.",
    clients: 2,
    steps: [
        // Create first file at A.md, rename to B.md
        { type: "create", client: 0, path: "A.md", content: "first file" },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "B.md" },

        // Create second file at A.md (now free), rename to C.md
        { type: "create", client: 0, path: "A.md", content: "second file" },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "C.md" },

        // Create third file at A.md
        { type: "create", client: 0, path: "A.md", content: "third file" },

        // Enable sync
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // All three files should exist on both clients
        { type: "assert-consistent", verify: verifyThreeFiles }
    ]
};
