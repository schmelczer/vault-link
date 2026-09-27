import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const sameDocIdCollapseAfterRemoteQuickWriteAndPendingRenameTest: TestDefinition =
    {
        description:
            "A remote create starts quick-writing at doc.md while a local " +
            "create for the same path is queued and renamed to renamed.md. " +
            "Because the local create was renamed before it reached the " +
            "server, the two generations should remain separate tracked " +
            "documents.",
        clients: 2,
        steps: [
            { type: "enable-sync", client: 0 },

            {
                type: "create",
                client: 0,
                path: "history.md",
                content: "history-v1"
            },
            { type: "sync", client: 0 },
            {
                type: "update",
                client: 0,
                path: "history.md",
                content: "history-v2"
            },
            { type: "sync", client: 0 },
            { type: "delete", client: 0, path: "history.md" },
            { type: "sync", client: 0 },

            { type: "enable-sync", client: 1 },
            { type: "sync", client: 1 },

            {
                type: "hold-request",
                client: 1,
                kind: "read-content",
                point: "after"
            },

            {
                type: "create",
                client: 0,
                path: "doc.md",
                content: "remote\n"
            },
            { type: "sync", client: 0 },

            { type: "wait-for-request", client: 1 },

            {
                type: "create",
                client: 1,
                path: "doc.md",
                content: "local\n"
            },
            {
                type: "rename",
                client: 1,
                oldPath: "doc.md",
                newPath: "renamed.md"
            },

            { type: "release-request", client: 1 },
            { type: "barrier" },

            {
                type: "assert-consistent",
                verify: (state: AssertableState): void => {
                    state.assertFileCount(2);
                    state.assertContent("doc.md", "remote\n");
                    state.assertContent("renamed.md", "local\n");
                }
            }
        ]
    };
