import { parentPort, workerData } from "node:worker_threads";
import assert from "node:assert/strict";
import { SyncClient } from "sync-client";
import {
    MemoryDisk,
    MemoryPersistence,
    type DiskImage,
    type StoredClient
} from "../../test-support/storage";
import {
    classifyRequest,
    type RequestRecord,
    type RequestKind
} from "../../test-support/network";

export interface CrashWorkerInput {
    disk: DiskImage;
    stored: StoredClient;
    stopAt?: RequestKind;
    editAfterSync?: { path: string; content: string };
}
const input = workerData as CrashWorkerInput;
const disk = new MemoryDisk();
disk.restore(input.disk);
const persistence = new MemoryPersistence(input.stored);
const requests: RequestRecord[] = [];
let editedBase: { documentId: string; vaultUpdateId: number } | undefined;
const snapshot = () => ({
    disk: disk.image(),
    stored: persistence.snapshot(),
    requests,
    editedBase
});

async function main() {
    const client = await SyncClient.create({
        fs: disk.session(),
        persistence,
        fetch: async (url, init) => {
            const record = classifyRequest(url, init);
            if (record) requests.push(record);
            const response = await fetch(url, init);
            if (record && response.ok && input.stopAt === record.kind) {
                const receipt = (await response.clone().json()) as {
                    type: string;
                };
                if (receipt.type === "Accepted") {
                    parentPort!.postMessage({
                        type: "checkpoint",
                        ...snapshot()
                    });
                    // Parent terminates this worker. No destroy(), no state flush,
                    // no finally block, and no old runtime survives the restart.
                    await new Promise<never>(() => {});
                }
            }
            return response;
        }
    });
    assert.equal(
        client.getSettings().syncIntervalMs,
        0,
        "Crash recovery must preserve the disabled polling setting"
    );
    await client.start();
    await client.waitUntilFinished();
    if (input.editAfterSync) {
        const state = persistence.snapshot().database!;
        const documentId = Object.keys(state.local!).find(
            (id) => state.local![id] === input.editAfterSync!.path
        );
        assert(documentId, "Edit must target an established document");
        editedBase = {
            documentId,
            vaultUpdateId: state.documents![documentId].base!.vaultUpdateId
        };
        await disk.userWrite(
            input.editAfterSync.path,
            new TextEncoder().encode(input.editAfterSync.content)
        );
        await client.syncLocallyUpdatedFile({
            relativePath: input.editAfterSync.path
        });
        await client.waitUntilFinished();
    }
    await client.destroy();
    parentPort!.postMessage({ type: "finished", ...snapshot() });
    parentPort!.close();
}
main().catch((error: unknown) => {
    parentPort!.postMessage({ type: "error", error: String(error) });
    process.exit(1);
});
