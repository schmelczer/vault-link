import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const doubleOfflineCycleTest: TestDefinition = {
    description:
        "Client 0 goes through three offline-edit-reconnect cycles. " +
        "Each offline edit must propagate to client 1 after reconnection.",
    clients: 2,
    steps: [
        {
            type: "create",
            client: 0,
            path: "doc.md",
            content: "initial"
        },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("doc.md", "initial");
            }
        },

        { type: "disable-sync", client: 0 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "first edit"
        },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("doc.md", "first edit");
            }
        },

        { type: "disable-sync", client: 0 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "second edit"
        },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertContent("doc.md", "second edit");
            }
        },

        { type: "disable-sync", client: 0 },
        {
            type: "update",
            client: 0,
            path: "doc.md",
            content: "third edit"
        },

        { type: "enable-sync", client: 0 },
        { type: "sync" },
        { type: "barrier" },
        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContent("doc.md", "third edit");
            }
        }
    ]
};
