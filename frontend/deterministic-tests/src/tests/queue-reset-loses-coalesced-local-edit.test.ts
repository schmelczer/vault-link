import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const queueResetLosesCoalescedLocalEditTest: TestDefinition = {
    description:
        "Client 0 goes offline, both clients edit doc.md concurrently, " +
        "then client 0 reconnects. Both edits must be preserved.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "original" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 0 },

        { type: "update", client: 1, path: "doc.md", content: "alpha bravo" },
        { type: "sync", client: 1 },

        { type: "update", client: 0, path: "doc.md", content: "charlie delta" },

        { type: "enable-sync", client: 0 },
        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(1).assertContains(
                    "doc.md",
                    "alpha",
                    "charlie"
                );
            }
        }
    ]
};
