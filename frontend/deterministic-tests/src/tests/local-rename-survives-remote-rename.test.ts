import type { TestDefinition } from "../test-definition";

export const localRenameSurvivesRemoteRenameTest: TestDefinition = {
    description:
        "A held remote manifest races with a local rename and a separate edit; the first committed rename wins and both identities survive.",
    clients: 2,
    steps: [
        { type: "enable-sync", client: 0 },
        { type: "enable-sync", client: 1 },
        { type: "create", client: 0, path: "doc.md", content: "v1\n" },
        { type: "create", client: 0, path: "sentinel.md", content: "s\n" },
        { type: "barrier" },
        {
            type: "assert-documents",
            expected: [
                { key: "note", path: "doc.md", content: "v1\n" },
                { key: "sentinel", path: "sentinel.md", content: "s\n" }
            ]
        },
        { type: "hold-request", client: 0, kind: "events", point: "after" },
        { type: "rename", client: 1, oldPath: "doc.md", newPath: "remote.md" },
        { type: "wait-for-request", client: 0 },
        {
            type: "update",
            client: 0,
            path: "sentinel.md",
            content: "s\nedit\n"
        },
        { type: "rename", client: 0, oldPath: "doc.md", newPath: "local.md" },
        { type: "release-request", client: 0 },
        { type: "barrier" },
        {
            type: "assert-documents",
            expected: [
                { key: "note", path: "remote.md", content: "v1\n" },
                { key: "sentinel", path: "sentinel.md", content: "s\nedit\n" }
            ]
        }
    ]
};
