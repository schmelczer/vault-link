import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const displacedFileNotMarkedDeletedTest: TestDefinition = {
    description:
        "Client 0 creates a new file at path B.md while client 1 renames " +
        "A.md to B.md. The remote download of B.md displaces client 1's " +
        "renamed file. The displaced document must not be permanently " +
        "marked as recently deleted, so it can still be synced.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content of A" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        { type: "create", client: 0, path: "B.md", content: "new file B" },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "C.md" },
        { type: "sync", client: 0 },

        { type: "rename", client: 1, oldPath: "A.md", newPath: "B.md" },
        {
            type: "update",
            client: 1,
            path: "B.md",
            content: "edited A content"
        },
        { type: "enable-sync", client: 1 },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (state: AssertableState): void => {
                state
                    .assertFileNotExists("A.md")
                    .assertFileExists("B.md")
                    .assertContains("B.md", "new file B")
                    .assertFileExists("C.md")
                    .assertContains("C.md", "edited A content");
            }
        }
    ]
};
