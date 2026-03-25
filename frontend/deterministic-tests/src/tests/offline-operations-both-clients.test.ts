import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyAllPresent(state: ClientState): void {
    assert(
        state.files.size === 2,
        `Expected 2 files, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.get("A.md") === "from-client-0",
        `Expected A.md = "from-client-0", got: "${state.files.get("A.md")}"`
    );
    assert(
        state.files.get("B.md") === "from-client-1",
        `Expected B.md = "from-client-1", got: "${state.files.get("B.md")}"`
    );
}

export const offlineOperationsBothClientsTest: TestDefinition = {
    name: "Both Clients Offline Then Sync",
    description:
        "Both clients start offline. Client 0 creates A.md, Client 1 creates B.md. " +
        "Both enable sync simultaneously. Both files should appear on both clients.",
    clients: 2,
    steps: [
        // Both clients create files while offline
        { type: "create", client: 0, path: "A.md", content: "from-client-0" },
        { type: "create", client: 1, path: "B.md", content: "from-client-1" },

        // Both enable sync at the same time
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Both should have both files
        { type: "assert-exists", client: 0, path: "A.md" },
        { type: "assert-exists", client: 0, path: "B.md" },
        { type: "assert-exists", client: 1, path: "A.md" },
        { type: "assert-exists", client: 1, path: "B.md" },
        { type: "assert-consistent", verify: verifyAllPresent }
    ]
};
