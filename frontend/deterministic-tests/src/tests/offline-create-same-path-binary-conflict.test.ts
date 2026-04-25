import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineCreateSamePathMergeableTest: TestDefinition = {
    description:
        "Both clients create a file at the same path while offline with different text content. " +
        "After both sync, both clients must converge to a merged result containing both contributions.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "notes.md",
            content: "alpha wrote this line"
        },
        {
            type: "create",
            client: 1,
            path: "notes.md",
            content: "beta wrote this different line"
        },

        { type: "enable-sync", client: 0 },
        { type: "sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1)
                    .assertFileExists("notes.md")
                    .assertContains(
                        "notes.md",
                        "alpha wrote this line",
                        "beta wrote this different line"
                    );
            }
        }
    ]
};
