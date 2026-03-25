import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifySwap(state: ClientState): void {
    assert(
        state.files.has("A.md"),
        `Expected A.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    // After the swap, A.md should have B's original content and vice versa
    assert(
        state.files.get("A.md") === "content-b",
        `Expected A.md to have "content-b" after swap, got: "${state.files.get("A.md")}"`
    );
    assert(
        state.files.get("B.md") === "content-a",
        `Expected B.md to have "content-a" after swap, got: "${state.files.get("B.md")}"`
    );
}

export const renameSwapTest: TestDefinition = {
    name: "Offline Swap via Temp File",
    description:
        "Client 0 has A.md and B.md synced. Goes offline and swaps them using " +
        "a temp file: A.md -> temp.md, B.md -> A.md, temp.md -> B.md. " +
        "When Client 0 reconnects, both clients should have swapped content. " +
        "The temp file should not exist on either client.",
    clients: 2,
    steps: [
        // Setup: create both files and sync to both clients
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "A.md", content: "content-a" },
        { type: "assert-content", client: 1, path: "B.md", content: "content-b" },

        // Client 0 goes offline and performs the swap
        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "temp.md" },
        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },
        { type: "rename", client: 0, oldPath: "temp.md", newPath: "B.md" },

        // Client 0 reconnects
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // temp.md should not exist on either client
        { type: "assert-not-exists", client: 0, path: "temp.md" },
        { type: "assert-not-exists", client: 1, path: "temp.md" },

        // Both clients should have the swapped content
        { type: "assert-consistent", verify: verifySwap }
    ]
};
