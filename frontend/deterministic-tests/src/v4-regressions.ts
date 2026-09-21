import type { TestDefinition, TestStep } from "./test-definition";

const online: TestStep[] = [
    { type: "enable-sync", client: 0 },
    { type: "enable-sync", client: 1 },
    { type: "barrier" }
];
const offline: TestStep[] = [
    { type: "disable-sync", client: 0 },
    { type: "disable-sync", client: 1 }
];
export const V4_TESTS: Record<string, TestDefinition> = {
    "v4-text-byte-and-component-boundaries": {
        clients: 2,
        steps: [
            ...online,
            { type: "create", client: 0, path: "empty.md", content: "" },
            {
                type: "create",
                client: 0,
                path: "bom.md",
                content: "\ufefffirst\r\nlast"
            },
            {
                type: "create",
                client: 0,
                path: `${"a".repeat(252)}.md`,
                content: "255 ASCII bytes"
            },
            {
                type: "create",
                client: 0,
                path: `${"é".repeat(126)}.md`,
                content: "255 UTF-8 bytes"
            },
            { type: "barrier" },
            {
                type: "assert-files",
                count: 4,
                expected: {
                    "empty.md": "",
                    "bom.md": "\ufefffirst\r\nlast",
                    [`${"a".repeat(252)}.md`]: "255 ASCII bytes",
                    [`${"é".repeat(126)}.md`]: "255 UTF-8 bytes"
                }
            }
        ]
    },
    "v4-binary-bytes-and-independent-identities": {
        clients: 2,
        steps: [
            ...online,
            ...offline,
            {
                type: "create-bytes",
                client: 0,
                path: "nested/blob.bin",
                bytes: [0, 255, 254, 128, 13, 10]
            },
            {
                type: "create-bytes",
                client: 1,
                path: "nested/blob.bin",
                bytes: [0, 254, 255, 129, 10, 13]
            },
            ...online,
            {
                type: "assert-consistent",
                verify: (state) => {
                    state
                        .assertFileCount(2)
                        .assertBytes(
                            "nested/blob.bin",
                            new Uint8Array([0, 255, 254, 128, 13, 10])
                        );
                    state.assertBytes(
                        state.conflictPath("nested/blob.bin"),
                        new Uint8Array([0, 254, 255, 129, 10, 13])
                    );
                }
            }
        ]
    },
    "v4-three-file-cycle-preserves-identities": {
        clients: 2,
        steps: [
            ...online,
            { type: "create", client: 0, path: "a.md", content: "A" },
            { type: "create", client: 0, path: "b.md", content: "B" },
            { type: "create", client: 0, path: "c.md", content: "C" },
            { type: "barrier" },
            { type: "remember-identity", key: "a", path: "a.md" },
            { type: "remember-identity", key: "b", path: "b.md" },
            { type: "remember-identity", key: "c", path: "c.md" },
            { type: "disable-sync", client: 0 },
            { type: "delay-notifications", client: 0 },
            { type: "rename", client: 0, oldPath: "a.md", newPath: "temp.md" },
            { type: "rename", client: 0, oldPath: "b.md", newPath: "a.md" },
            { type: "rename", client: 0, oldPath: "c.md", newPath: "b.md" },
            { type: "rename", client: 0, oldPath: "temp.md", newPath: "c.md" },
            {
                type: "update",
                client: 0,
                path: "c.md",
                content: "A edited offline"
            },
            { type: "flush-notifications", client: 0 },
            { type: "enable-sync", client: 0 },
            { type: "barrier" },
            { type: "assert-identity", key: "a", path: "c.md" },
            { type: "assert-identity", key: "b", path: "a.md" },
            { type: "assert-identity", key: "c", path: "b.md" },
            {
                type: "assert-files",
                count: 3,
                expected: {
                    "a.md": "B",
                    "b.md": "C",
                    "c.md": "A edited offline"
                },
                absent: ["temp.md"]
            }
        ]
    },
    "v4-case-alias-and-file-directory-conflicts": {
        clients: 2,
        steps: [
            ...online,
            ...offline,
            {
                type: "create",
                client: 0,
                path: "folder/note.md",
                content: "nested file"
            },
            {
                type: "create",
                client: 0,
                path: "README.md",
                content: "uppercase file"
            },
            {
                type: "create",
                client: 1,
                path: "folder",
                content: "blocking file"
            },
            {
                type: "create",
                client: 1,
                path: "readme.md",
                content: "lowercase file"
            },
            ...online,
            {
                type: "assert-consistent",
                verify: (state) => {
                    state
                        .assertFileCount(4)
                        .assertContent("folder/note.md", "nested file")
                        .assertContent("README.md", "uppercase file");
                    state.assertAnyFileContains(
                        "blocking file",
                        "lowercase file"
                    );
                }
            },
            {
                type: "assert-markers",
                markers: [
                    "nested file",
                    "blocking file",
                    "uppercase file",
                    "lowercase file"
                ]
            }
        ]
    },
    "v4-server-sigkill-retains-acknowledged-state": {
        clients: 2,
        steps: [
            ...online,
            {
                type: "create",
                client: 0,
                path: "a.md",
                content: "durable bytes"
            },
            { type: "barrier" },
            { type: "remember-identity", key: "a", path: "a.md" },
            ...offline,
            { type: "crash-server" },
            { type: "restart-server" },
            ...online,
            { type: "assert-identity", key: "a", path: "a.md" },
            {
                type: "assert-files",
                count: 1,
                expected: { "a.md": "durable bytes" }
            }
        ]
    }
};

for (const kind of ["create", "content", "manifest"] as const) {
    for (const point of ["before", "after"] as const) {
        V4_TESTS[`v4-${kind}-${point}-commit-network-loss`] = {
            clients: 2,
            steps: [
                ...online,
                ...(kind === "content"
                    ? ([
                          {
                              type: "create",
                              client: 0,
                              path: "file.md",
                              content: "old bytes"
                          },
                          { type: "barrier" },
                          {
                              type: "remember-identity",
                              key: "updated-file",
                              path: "file.md"
                          }
                      ] as TestStep[])
                    : []),
                { type: "drop-response", client: 0, kind, point },
                {
                    type: kind === "content" ? "update" : "create",
                    client: 0,
                    path: "file.md",
                    content: "must survive retry"
                },
                { type: "wait-for-response-drop", client: 0 },
                { type: "barrier" },
                ...(kind === "content"
                    ? [
                          {
                              type: "assert-identity",
                              key: "updated-file",
                              path: "file.md"
                          } as TestStep
                      ]
                    : []),
                {
                    type: "assert-files",
                    count: 1,
                    expected: { "file.md": "must survive retry" }
                }
            ]
        };
    }
}
