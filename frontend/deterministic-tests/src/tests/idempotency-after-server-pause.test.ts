import type { ClientState, TestDefinition } from "../test-definition";
import { assert } from "../utils/assert";

function verifyNoDuplicates(state: ClientState): void {
    assert(
        state.files.size === 1,
        `Expected exactly 1 file, got ${state.files.size}: ${Array.from(state.files.keys()).join(", ")}`
    );
    assert(
        state.files.has("doc.md"),
        `Expected doc.md to exist, got: ${Array.from(state.files.keys()).join(", ")}`
    );
    const content = state.files.get("doc.md") ?? "";
    assert(
        content === "important data",
        `Expected doc.md content to be "important data", got: "${content}"`
    );
}

export const idempotencyAfterServerPauseTest: TestDefinition = {
    name: "Idempotency Key Prevents Duplicates After Server Pause",
    description:
        "Client 0 creates a file. The server is paused mid-response (SIGSTOP), " +
        "so the client's HTTP request stalls. When the server resumes, the " +
        "idempotency key should prevent duplicate documents from being created. " +
        "Both clients must converge to a single copy of the file.",
    clients: 2,
    steps: [
        // Both clients online
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        // Client 0 creates a file, then immediately pause the server so the
        // response is stalled (the server may or may not have committed the
        // create — either way the idempotency key protects us).
        { type: "create", client: 0, path: "doc.md", content: "important data" },
        { type: "pause-server" },

        // Wait with server frozen — client's in-flight create request is stuck.

        // Resume the server. The stalled request completes (or the client
        // retries with the same idempotency key).
        { type: "resume-server" },

        // Sync and converge
        { type: "sync" },
        { type: "barrier" },

        // There must be exactly one doc.md with the correct content — no
        // duplicates like "doc (1).md".
        { type: "assert-consistent", verify: verifyNoDuplicates }
    ]
};
