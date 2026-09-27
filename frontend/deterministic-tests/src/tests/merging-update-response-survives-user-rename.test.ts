import type { TestDefinition } from "../test-definition";

export const mergingUpdateResponseSurvivesUserRenameTest: TestDefinition = {
    description:
        "A proven stale content CAS is reconciled after the user renames its file.",
    clients: 2,
    steps: [
        { type: "create", client: 0, path: "doc.md", content: "0\n" },
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "barrier" },
        {
            type: "assert-documents",
            expected: [{ key: "note", path: "doc.md", content: "0\n" }]
        },
        { type: "hold-request", client: 1, kind: "content", point: "before" },
        { type: "update", client: 1, path: "doc.md", content: "0\nB\n" },
        { type: "wait-for-request", client: 1 },
        { type: "update", client: 0, path: "doc.md", content: "0\nA\n" },
        { type: "sync", client: 0 },
        { type: "rename", client: 1, oldPath: "doc.md", newPath: "renamed.md" },
        { type: "release-request", client: 1 },
        { type: "barrier" },
        {
            type: "assert-response",
            client: 1,
            kind: "content",
            responseType: "StaleBase",
            count: 1
        },
        {
            type: "assert-documents",
            expected: [
                { key: "note", path: "renamed.md", content: "0\nA\nB\n" }
            ]
        }
    ]
};
