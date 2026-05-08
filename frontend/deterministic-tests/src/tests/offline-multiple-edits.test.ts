import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineMultipleEditsTest: TestDefinition = {
    description:
        "Client 0 creates a file and syncs. Client 0 goes offline, edits the file " +
        "5 times with different content. When Client 0 reconnects, both clients " +
        "must converge to the final version.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("doc.md", "original");
            }
        },

        { type: "disable-sync", client: 0 },

        { type: "update", client: 0, path: "doc.md", content: "edit-1" },
        { type: "update", client: 0, path: "doc.md", content: "edit-2" },
        { type: "update", client: 0, path: "doc.md", content: "edit-3" },
        { type: "update", client: 0, path: "doc.md", content: "edit-4" },
        { type: "update", client: 0, path: "doc.md", content: "edit-5-final" },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("doc.md", "edit-5-final");
            }
        }
    ]
};
