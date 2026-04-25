import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const moveChainThreeFilesTest: TestDefinition = {
    description:
        "Three files have their contents rotated (A gets C's content, B gets A's, C gets B's) " +
        "while offline. After reconnecting, both clients should converge with the rotated contents.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        { type: "create", client: 0, path: "A.md", content: "was A" },
        { type: "create", client: 0, path: "B.md", content: "was B" },
        { type: "create", client: 0, path: "C.md", content: "was C" },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },

        { type: "delete", client: 0, path: "A.md" },
        { type: "delete", client: 0, path: "B.md" },
        { type: "delete", client: 0, path: "C.md" },

        { type: "create", client: 0, path: "A.md", content: "was C" },
        { type: "create", client: 0, path: "B.md", content: "was A" },
        { type: "create", client: 0, path: "C.md", content: "was B" },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertFileCount(3)
                    .assertContent("A.md", "was C")
                    .assertContent("B.md", "was A")
                    .assertContent("C.md", "was B");
            }
        }
    ]
};
