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
}

export const writeWriteConflictTest: TestDefinition = {
    name: "Write/Write Conflict",
    description:
        "Two clients simultaneously create the same file with different content. " +
        "The system should resolve the conflict and both clients should converge.",
    clients: 2,
    steps: [
        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },
        { type: "create", client: 0, path: "A.md", content: "hello" },
        { type: "create", client: 1, path: "A.md", content: "world" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        { type: "assert-consistent", verify: verifyMergedContent }
    ]
};
