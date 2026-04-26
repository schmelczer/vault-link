import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const overlappingEditsSameSectionTest: TestDefinition = {
    description:
        "Both clients go offline and edit different parts of the same document. " +
        "After both reconnect, both edits must be preserved without data loss.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "# Title\n\nfooter"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },
        { type: "disable-sync", client: 1 },

        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "# Title\nalpha addition\n\nfooter"
        },

        {
            type: "update",
            client: 1,
            path: "doc.md",
            content: "# Title\n\nbeta addition\nfooter"
        },

        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContains(
                    "doc.md",
                    "# Title",
                    "alpha addition",
                    "beta addition",
                    "footer"
                );
            }
        }
    ]
};
