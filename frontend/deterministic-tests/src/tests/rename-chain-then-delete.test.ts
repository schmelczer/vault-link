import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const renameChainThenDeleteTest: TestDefinition = {
    description:
        "Client 0 renames X.md to Y.md to Z.md, then deletes Z.md while client 1 is offline. " +
        "After client 1 reconnects, both clients must have no files.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "X.md", content: "chain-content" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("X.md", "chain-content");
            }
        },

        { type: "disable-sync", client: 1 },

        {
            type: "rename",
            client: 0,
            oldPath: "X.md",
            newPath: "Y.md"
        },
        { type: "sync", client: 0 },
        {
            type: "rename",
            client: 0,
            oldPath: "Y.md",
            newPath: "Z.md"
        },
        { type: "sync", client: 0 },
        { type: "delete", client: 0, path: "Z.md" },
        { type: "sync", client: 0 },

        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(0);
            }
        }
    ]
};
