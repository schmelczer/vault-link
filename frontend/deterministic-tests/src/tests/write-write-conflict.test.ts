import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyMergedContent(state: ClientState): void {
    assert(state.files.size === 1, `Expected 1 file, got ${state.files.size}`);
    assert(state.files.has("A.md"), "Expected A.md to exist");
    const content = state.files.get("A.md") ?? "";
    assert(
        content.includes("hello") && content.includes("world"),
        `Expected A.md to contain both "hello" and "world", got: "${content}"`
    );
    // Verify no duplication — each word should appear exactly once
    const helloCount = content.split("hello").length - 1;
    const worldCount = content.split("world").length - 1;
    assert(
        helloCount === 1,
        `Expected "hello" to appear once, appeared ${helloCount} times in: "${content}"`
    );
    assert(
        worldCount === 1,
        `Expected "world" to appear once, appeared ${worldCount} times in: "${content}"`
    );
}

export const writeWriteConflictTest: TestDefinition = {
    name: "Write/Write Conflict",
    description:
        "Two clients simultaneously create the same file with different content. " +
        "The system should resolve the conflict and both clients should converge.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "hello" },
        { type: "create", client: 1, path: "A.md", content: "world" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        { type: "assert-consistent", verify: verifyMergedContent }
    ]
};
