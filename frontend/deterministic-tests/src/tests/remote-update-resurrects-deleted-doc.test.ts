import type { TestDefinition } from "../test-definition";

export const remoteUpdateResurrectsDeletedDocTest: TestDefinition = {
    description:
        "Hold a remote content download while the peer deletes and recreates its path. A local edit to the old generation during this download must not resurrect it or overwrite the new identity.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },

        { type: "create", client: 1, path: "P.md", content: "v8 content\n" },
        { type: "barrier" },

        { type: "remember-identity", path: "P.md", key: "original" },
        {
            type: "hold-request",
            client: 0,
            kind: "read-content",
            point: "after"
        },

        {
            type: "update",
            client: 1,
            path: "P.md",
            content: "v17 content from client 1\n"
        },
        { type: "sync", client: 1 },
        { type: "wait-for-request", client: 0 },
        { type: "delete", client: 1, path: "P.md" },
        { type: "sync", client: 1 },
        {
            type: "create",
            client: 1,
            path: "P.md",
            content: "v21 content (D2)\n"
        },
        { type: "sync", client: 1 },

        {
            type: "remember-local-identity",
            client: 1,
            path: "P.md",
            key: "replacement"
        },

        {
            type: "update",
            client: 0,
            path: "P.md",
            content: "local edit by client 0\n"
        },

        { type: "release-request", client: 0 },
        { type: "barrier" },

        {
            type: "assert-documents",
            expected: [
                {
                    key: "replacement",
                    path: "P.md",
                    content: "v21 content (D2)\n"
                }
            ]
        }
    ]
};
