import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const onlineBothCreateSamePathDeconflictTest: TestDefinition = {
    description:
        "Both clients create a file at the same path while online. " +
        "One client's create gets deconflicted by the server. " +
        "Both files must exist on both clients after convergence.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "pause-observation", client: 1 },
        { type: "create", client: 0, path: "A.md", content: " from-client-0 " },
        { type: "update", client: 0, path: "A.md", content: " updated-by-0 " },
        { type: "sync" },

        { type: "create", client: 1, path: "A.md", content: " from-client-1 " },
        { type: "wait-for-observation", client: 1 },
        { type: "sync", client: 0 },
        { type: "resume-observation", client: 1 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(2)
                    .assertContent("A.md", " updated-by-0 ")
                    .assertContent(s.conflictPath("A.md"), " from-client-1 ");
            }
        }
    ]
};
