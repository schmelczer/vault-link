/* eslint-disable @typescript-eslint/no-unsafe-type-assertion -- No filesystem operation is reached before initialization. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { SyncClient } from "./sync-client";
import type { FileSystemOperations } from "./file-operations/filesystem-operations";
import { awaitAll } from "./utils/await-all";

test("destroy during startup metadata work cannot restart the client", async () => {
    const saving = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const client = await SyncClient.create({
        fs: {} as FileSystemOperations,
        persistence: {
            load: async () => ({
                settings: {
                    isSyncEnabled: true,
                    enableTelemetry: false,
                    remoteUri: "http://test"
                }
            }),
            save: async () => {
                saving.resolve(undefined);
                await release.promise;
            }
        },
        fetch: async () => {
            assert.fail("a destroyed client must not start network requests");
        }
    });

    const notification = client.syncLocallyCreatedFile("note.md");
    await saving.promise;
    const starting = client.start();
    // Let start acquire the lifecycle lock and begin draining notification saves.
    await Promise.resolve();
    const destroying = client.destroy();
    release.resolve(undefined);
    await awaitAll([notification, starting, destroying]);

    await assert.rejects(client.start(), /destroyed/u);
});
