import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const serverPauseBothClientsCreateTest: TestDefinition = {
    description:
        "Client 0 creates and FULLY syncs alpha.md before the server is " +
        "paused, then Client 1 creates beta.md while the server is paused. " +
        "After resume, both clients must hold both files. The `sync` after " +
        "Client 0's create is required: without it the create is fire-" +
        "and-forget and SIGSTOP can land before the POST hits the server, " +
        "reducing the test to two creates against a paused server (a " +
        "different scenario from the named one).",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "create",
            client: 0,
            path: "alpha.md",
            content: "from client 0"
        },
        // Deterministic happens-before: alpha.md is on the server before
        // SIGSTOP. Without this, the test races the in-flight POST.
        { type: "sync", client: 0 },

        { type: "pause-server" },

        {
            type: "create",
            client: 1,
            path: "beta.md",
            content: "from client 1"
        },

        { type: "resume-server" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(2)
                    .assertContent("alpha.md", "from client 0")
                    .assertContent("beta.md", "from client 1");
            }
        }
    ]
};
