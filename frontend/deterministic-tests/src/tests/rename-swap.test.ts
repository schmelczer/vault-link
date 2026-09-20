import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renameSwapTest: TestDefinition = {
    description:
        "Client 0 has A.md and B.md synced. Goes offline and swaps them using " +
        "a temp file: A.md -> temp.md, B.md -> A.md, temp.md -> B.md. " +
        "When Client 0 reconnects, both UUIDs must follow their files to the swapped paths.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "content-a" },
        { type: "create", client: 0, path: "B.md", content: "content-b" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("A.md", "content-a").assertContent(
                    "B.md",
                    "content-b"
                );
            }
        },

        { type: "remember-identity", key: "A", path: "A.md" },
        { type: "remember-identity", key: "B", path: "B.md" },
        { type: "disable-sync", client: 0 },
        { type: "rename", client: 0, oldPath: "A.md", newPath: "temp.md" },
        { type: "rename", client: 0, oldPath: "B.md", newPath: "A.md" },
        { type: "rename", client: 0, oldPath: "temp.md", newPath: "B.md" },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },
        { type: "assert-identity", key: "A", path: "B.md" },
        { type: "assert-identity", key: "B", path: "A.md" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileNotExists("temp.md")
                    .assertFileCount(2)
                    .assertContent("A.md", "content-b")
                    .assertContent("B.md", "content-a");
            }
        }
    ]
};
