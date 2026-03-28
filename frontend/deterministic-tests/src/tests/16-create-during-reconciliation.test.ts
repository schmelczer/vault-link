import type { TestDefinition } from "../test-definition";

export const createDuringReconciliationTest: TestDefinition = {
    description:
        "Client creates two files while offline, reconnects, then immediately " +
        "creates a third file. All three files should sync to the other client.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "offline A"
        },
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "offline B"
        },

        { type: "enable-sync", client: 0 },

        {
            type: "create",
            client: 0,
            path: "C.md",
            content: "post-reconnect C"
        },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state) => {
                state
                    .assertFileCount(3)
                    .assertContent("A.md", "offline A")
                    .assertContent("B.md", "offline B")
                    .assertContent("C.md", "post-reconnect C");
            }
        }
    ]
};
