import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyCircularRotation(state: ClientState): void {
    // Temp file must not survive the rotation
    assert(
        !state.files.has("temp-a.md"),
        `temp-a.md should not exist after rotation, got: ${Array.from(state.files.keys()).join(", ")}`
    );

    // Exactly 3 files should exist
    assert(
        state.files.size === 3,
        `Expected exactly 3 files after rotation, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );

    assert(
        state.files.has("A.md"),
        `Expected A.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("B.md"),
        `Expected B.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("C.md"),
        `Expected C.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );

    // After circular rename A->B, B->C, C->A:
    // A.md should have C's original content
    // B.md should have A's original content
    // C.md should have B's original content
    assert(
        state.files.get("A.md") === "content-c",
        `Expected A.md to have "content-c" after rotation, got: "${state.files.get("A.md")}"`
    );
    assert(
        state.files.get("B.md") === "content-a",
        `Expected B.md to have "content-a" after rotation, got: "${state.files.get("B.md")}"`
    );
    assert(
        state.files.get("C.md") === "content-b",
        `Expected C.md to have "content-b" after rotation, got: "${state.files.get("C.md")}"`
    );
}

export const renameCircularTest: TestDefinition = {
    name: "Circular Rename Chain (3-Way Swap)",
    description:
        "Client 0 has A.md, B.md, C.md synced. Goes offline and performs a " +
        "circular rename: A->B, B->C, C->A. This requires temp files to avoid " +
        "overwriting. When Client 0 reconnects, all three files should have " +
        "rotated content on both clients.",
    clients: 2,
    steps: [
        // Setup: create three files and sync to both clients
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "create", client: 0, path: "C.md", content: "content-c" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-content", client: 1, path: "A.md", content: "content-a" },
        { type: "assert-content", client: 1, path: "B.md", content: "content-b" },
        { type: "assert-content", client: 1, path: "C.md", content: "content-c" },

        // Client 0 goes offline and performs the 3-way circular rename
        // To avoid overwriting, we use temp files:
        // 1. A.md -> temp-a.md (save A's content)
        // 2. C.md -> A.md (A now has C's content)
        // 3. B.md -> C.md (C now has B's content)
        // 4. temp-a.md -> B.md (B now has A's content)
        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "temp-a.md" },
        { type: "rename", client: 0, oldPath: "C.md", newPath: "A.md" },
        { type: "rename", client: 0, oldPath: "B.md", newPath: "C.md" },
        { type: "rename", client: 0, oldPath: "temp-a.md", newPath: "B.md" },

        // Client 0 reconnects
        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },

        // Temp file should not exist on either client
        { type: "assert-not-exists", client: 0, path: "temp-a.md" },
        { type: "assert-not-exists", client: 1, path: "temp-a.md" },

        // All three files should exist with rotated content
        { type: "assert-consistent", verify: verifyCircularRotation }
    ]
};
