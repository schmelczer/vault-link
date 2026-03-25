import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyMergedContent(state: ClientState): void {
    // Both clients created at the same path with different-length content.
    // The server should 3-way merge them (empty parent). Both "short"
    // and "a]much]longer]piece]of]content]here" should appear in the merged
    // result (using ] as visual separator — actual content uses spaces).
    assert(
        state.files.size === 1,
        `Expected 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("shared.md"),
        `Expected shared.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const content = state.files.get("shared.md") ?? "";
    assert(
        content.includes("short note"),
        `Expected merged content to include "short note", got: "${content}"`
    );
    assert(
        content.includes("a much longer piece of content that one client wrote"),
        `Expected merged content to include the longer text, got: "${content}"`
    );
}

export const concurrentCreateSamePathMergeTest: TestDefinition = {
    name: "Concurrent Creates at Same Path Merge Content",
    description:
        "Two clients both create a file at the same path while offline. " +
        "Client 0 writes a short string, Client 1 writes a much longer " +
        "string. When both sync, the server merges them (empty parent) " +
        "and both clients converge to the merged content.",
    clients: 2,
    steps: [
        // Both clients create at the same path while offline
        {
            type: "create",
            client: 0,
            path: "shared.md",
            content: "short note"
        },
        {
            type: "create",
            client: 1,
            path: "shared.md",
            content: "a much longer piece of content that one client wrote"
        },

        // Enable sync on both
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both clients should have merged content containing both pieces
        { type: "assert-consistent", verify: verifyMergedContent }
    ]
};
