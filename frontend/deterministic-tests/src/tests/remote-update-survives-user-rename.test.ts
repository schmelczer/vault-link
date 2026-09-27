import type { TestDefinition } from "../test-definition";

export const remoteUpdateSurvivesUserRenameTest: TestDefinition = {
    description:
        "An observed remote content download is held while the user renames its destination.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "v1\n" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-documents",
            expected: [{ key: "note", path: "doc.md", content: "v1\n" }]
        },
        {
            type: "hold-request",
            client: 1,
            kind: "read-content",
            point: "after"
        },
        { type: "update", client: 0, path: "doc.md", content: "v2\n" },
        { type: "wait-for-request", client: 1 },
        { type: "rename", client: 1, oldPath: "doc.md", newPath: "renamed.md" },
        { type: "release-request", client: 1 },
        { type: "barrier" },
        {
            type: "assert-documents",
            expected: [{ key: "note", path: "renamed.md", content: "v2\n" }]
        }
    ]
};
