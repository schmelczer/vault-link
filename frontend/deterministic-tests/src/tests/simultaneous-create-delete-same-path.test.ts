import type { AssertableState } from "../utils/assertable-state";
import type { TestDefinition } from "../test-definition";

export const simultaneousCreateDeleteSamePathTest: TestDefinition = {
    description:
        "Client 0 creates A.md and syncs. Client 1 disables sync. Client 0 " +
        "deletes A.md and that delete reaches the server before Client 1 " +
        "reconnects. While offline, Client 1 updates A.md. On reconnect, " +
        "Client 1's update lands against an already-deleted server doc — " +
        "delete must win, both clients converge to zero files. (Filename is " +
        "legacy: there is no 'create' here; the scenario is online-delete " +
        "vs. offline-update, distinct from update-survives-remote-delete " +
        "where both clients are offline at delete time.)",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "A.md", content: "original from 0" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },

        { type: "disable-sync", client: 1 },

        { type: "delete", client: 0, path: "A.md" },
        { type: "sync", client: 0 },

        {
            type: "update",
            client: 1,
            path: "A.md",
            content: "modified by 1 while offline"
        },

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
