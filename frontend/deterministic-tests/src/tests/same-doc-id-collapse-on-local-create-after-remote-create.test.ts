import type { TestDefinition } from "../test-definition";

// Historical registry name retained so old reproduction commands still work.
export const sameDocIdCollapseOnLocalCreateAfterRemoteCreateTest: TestDefinition =
    {
        description:
            "Two initialized clients create distinct UUIDs at X.md while remote observation is held. V4 must preserve both identities/content after catchup; the server never merges creates by path.",
        clients: 2,
        steps: [
            { type: "enable-sync", client: 0 },
            { type: "enable-sync", client: 1 },
            { type: "barrier" },
            // Freeze HTTP catchup as well as WS. Pausing only WS is insufficient.
            { type: "pause-observation", client: 0 },
            {
                type: "create",
                client: 1,
                path: "X.md",
                content: "from-client-1"
            },
            { type: "sync", client: 1 },
            { type: "pause-server" },
            {
                type: "create",
                client: 0,
                path: "X.md",
                content: "from-client-0"
            },
            { type: "wait-for-observation", client: 0 },
            { type: "resume-observation", client: 0 },
            { type: "resume-server" },
            { type: "barrier" },
            {
                type: "assert-consistent",
                verify: (state) => {
                    state
                        .assertFileCount(2)
                        .assertContent("X.md", "from-client-1");
                    state.assertContent(
                        state.conflictPath("X.md"),
                        "from-client-0"
                    );
                }
            },
            {
                type: "assert-markers",
                markers: ["from-client-0", "from-client-1"]
            }
        ]
    };
