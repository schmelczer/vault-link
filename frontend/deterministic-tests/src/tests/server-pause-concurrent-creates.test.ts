import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyBothFilesPresent(state: ClientState): void {
    const allContent = Array.from(state.files.values()).join("\n");
    assert(
        allContent.includes("offline-alpha"),
        `Missing content "offline-alpha". Files: ${JSON.stringify(Object.fromEntries(state.files))}`
    );
    assert(
        allContent.includes("offline-beta"),
        `Missing content "offline-beta". Files: ${JSON.stringify(Object.fromEntries(state.files))}`
    );
}

export const serverPauseConcurrentCreatesTest: TestDefinition = {
    name: "Server Pause — Concurrent Creates From Both Clients",
    description:
        "The server is paused BEFORE either client creates anything. " +
        "Client 0 creates fileA.md and Client 1 creates fileB.md — both HTTP " +
        "requests stall because the server is frozen. After the server resumes, " +
        "both creates should complete and both files should appear on both clients. " +
        "This is a harder variant than the existing create-while-server-paused test " +
        "because BOTH clients have stalled pending creates simultaneously, testing " +
        "that the server correctly handles a burst of requests after SIGCONT and " +
        "that idempotency keys prevent duplicate documents if retries occur.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Pause the server FIRST — no requests can succeed
        { type: "pause-server" },

        // Both clients create different files while the server is frozen
        {
            type: "create",
            client: 0,
            path: "fileA.md",
            content: "offline-alpha"
        },
        {
            type: "create",
            client: 1,
            path: "fileB.md",
            content: "offline-beta"
        },

        // Resume the server — both pending creates should complete
        { type: "resume-server" },

        { type: "sync" },
        { type: "barrier" },

        // Both files must exist on both clients
        { type: "assert-exists", client: 0, path: "fileA.md" },
        { type: "assert-exists", client: 0, path: "fileB.md" },
        { type: "assert-exists", client: 1, path: "fileA.md" },
        { type: "assert-exists", client: 1, path: "fileB.md" },
        {
            type: "assert-content",
            client: 0,
            path: "fileA.md",
            content: "offline-alpha"
        },
        {
            type: "assert-content",
            client: 1,
            path: "fileA.md",
            content: "offline-alpha"
        },
        {
            type: "assert-content",
            client: 0,
            path: "fileB.md",
            content: "offline-beta"
        },
        {
            type: "assert-content",
            client: 1,
            path: "fileB.md",
            content: "offline-beta"
        },
        { type: "assert-consistent", verify: verifyBothFilesPresent }
    ]
};
