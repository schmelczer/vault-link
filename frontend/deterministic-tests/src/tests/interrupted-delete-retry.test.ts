import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const interruptedDeleteRetryTest: TestDefinition = {
    description:
        "Client 0's delete HTTP is interrupted (server paused) and must " +
        "retry on resume. Pause is established BEFORE the delete is " +
        "issued so the DELETE is deterministically in-flight against a " +
        "frozen server — the earlier ordering (delete then pause) raced " +
        "the request: under fast scheduling the DELETE could commit " +
        "before SIGSTOP and the test reduced to a trivial " +
        "create-then-delete with no interruption at all.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "to be deleted" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "pause-server" },
        { type: "delete", client: 0, path: "doc.md" },
        { type: "resume-server" },

        { type: "barrier" },

        {
            type: "assert-consistent",
            verify: (s: AssertableState): void => {
                s.assertFileCount(0);
            }
        }
    ]
};
