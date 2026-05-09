import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const onlineDeleteRecreateRapidCycleTest: TestDefinition = {
    description:
        "A file is deleted and recreated multiple times by alternating clients while both are online. " +
        "Both clients must converge after each cycle.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "round 0" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "delete", client: 1, path: "A.md" },
        { type: "barrier" },
        { type: "create", client: 0, path: "A.md", content: "round 1" },
        { type: "barrier" },

        { type: "delete", client: 0, path: "A.md" },
        { type: "barrier" },
        { type: "create", client: 1, path: "A.md", content: "round 2" },
        { type: "barrier" },

        { type: "delete", client: 1, path: "A.md" },
        { type: "barrier" },
        { type: "create", client: 0, path: "A.md", content: "round 3" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("A.md", "round 3");
            }
        }
    ]
};
