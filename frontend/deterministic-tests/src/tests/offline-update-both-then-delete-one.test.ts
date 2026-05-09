import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const offlineUpdateBothThenDeleteOneTest: TestDefinition = {
    description:
        "Client 0 goes offline, updates A.md and B.md, then deletes B.md. " +
        "Client 1 updates B.md while Client 0 is offline. When Client 0 " +
        "reconnects, A.md should have the update and B.md should be " +
        "consistently resolved (delete wins).",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "A.md",
            content: "A original"
        },
        {
            type: "create",
            client: 0,
            path: "B.md",
            content: "B original"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("A.md", "A original").assertContent(
                    "B.md",
                    "B original"
                );
            }
        },

        { type: "disable-sync", client: 0 },

        {
            type: "update",
            client: 0,
            path: "A.md",
            content: "A updated by client 0"
        },
        {
            type: "update",
            client: 0,
            path: "B.md",
            content: "B updated by client 0"
        },

        { type: "delete", client: 0, path: "B.md" },

        {
            type: "update",
            client: 1,
            path: "B.md",
            content: "B updated by client 1"
        },
        { type: "sync", client: 1 },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                // Delete must win for B.md: pin file count to 1 so a
                // deconflict carrying client 1's update of B.md cannot
                // silently sneak in.
                s.assertFileCount(1)
                    .assertContent("A.md", "A updated by client 0")
                    .assertFileNotExists("B.md");
            }
        }
    ]
};
