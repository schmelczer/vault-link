import type { ClientState, TestDefinition, TestStep } from "../test-definition";
import { assert } from "../utils/assert";

const FILE_COUNT = 20;

function buildSteps(): TestStep[] {
    const steps: TestStep[] = [];

    // Create N files offline on client 0
    for (let i = 0; i < FILE_COUNT; i++) {
        steps.push({
            type: "create",
            client: 0,
            path: `file-${String(i).padStart(3, "0")}.md`,
            content: `content-${i}`
        });
    }

    // Enable sync and converge
    steps.push({ type: "enable-sync", client: 0 });
    steps.push({ type: "enable-sync", client: 1 });
    steps.push({ type: "sync" });
    steps.push({ type: "barrier" });

    // Verify all files
    steps.push({
        type: "assert-consistent",
        verify: (state: ClientState) => {
            assert(
                state.files.size === FILE_COUNT,
                `Expected ${FILE_COUNT} files, got ${state.files.size}`
            );
            for (let i = 0; i < FILE_COUNT; i++) {
                const path = `file-${String(i).padStart(3, "0")}.md`;
                assert(state.files.has(path), `Missing file: ${path}`);
                assert(
                    state.files.get(path) === `content-${i}`,
                    `Wrong content for ${path}`
                );
            }
        }
    });

    return steps;
}

export const largeFileCountTest: TestDefinition = {
    name: "Large File Count Sync",
    description:
        `Client 0 creates ${FILE_COUNT} files offline. All should sync ` +
        "to Client 1 with correct content.",
    clients: 2,
    steps: buildSteps()
};
