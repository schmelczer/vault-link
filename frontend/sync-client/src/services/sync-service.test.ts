import assert from "node:assert/strict";
import { test } from "node:test";
import { Settings } from "../persistence/settings";
import { Logger } from "../tracing/logger";
import { SyncResetError } from "../errors/errors";
import { SyncService } from "./sync-service";

const settings = () =>
    new Settings(
        new Logger(),
        {
            remoteUri: "http://test",
            vaultName: "test",
            requestTimeoutMs: 1000
        },
        async () => {}
    );

test("paused sync sends no requests, while connection checks still work", async () => {
    let requests = 0;
    const service = new SyncService("device", settings(), async () => {
        requests++;
        return Response.json({ headEventId: 0, events: [] });
    });
    await assert.rejects(service.events(0), SyncResetError);
    assert.equal(requests, 0);
    await service.ping();
    assert.equal(requests, 1);
    service.resume();
    assert.equal((await service.events(0)).headEventId, 0);
    assert.equal(requests, 2);
});

test("pause aborts requests and fences late responses from an injected fetch", async () => {
    const response = Promise.withResolvers<Response>();
    const signals: AbortSignal[] = [];
    const saved: (string | undefined)[] = [];
    const service = new SyncService(
        "device",
        settings(),
        async (_, init) => {
            signals.push(init!.signal!);
            return signals.length === 1
                ? response.promise
                : Response.json({ headEventId: 0, events: [] });
        },
        {
            get: () => undefined,
            save: async (value) => {
                saved.push(value);
            }
        }
    );
    service.resume();
    const first = service.events(0);
    service.pause();
    await assert.rejects(first, SyncResetError);
    assert.equal(signals[0].aborted, true);
    service.resume();
    await service.events(0);
    assert.equal(signals[1].aborted, false);
    response.resolve(
        Response.json(
            {},
            { headers: { "X-Vault-Link-History": "99:abandoned" } }
        )
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(saved, []);
});

for (const binary of [false, true]) {
    test(`pause interrupts a stalled ${binary ? "binary" : "JSON"} response body`, async () => {
        const headersSaved = Promise.withResolvers<void>();
        let body!: ReadableStreamDefaultController<Uint8Array>;
        const service = new SyncService(
            "device",
            settings(),
            async () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            body = controller;
                        }
                    }),
                    { headers: { "X-Vault-Link-History": "1:head" } }
                ),
            {
                get: () => undefined,
                save: async () => {
                    headersSaved.resolve();
                }
            }
        );
        service.resume();
        const request = binary
            ? service.getDocumentVersionContent({
                  documentId: "a",
                  vaultUpdateId: 1
              })
            : service.events(0);
        await headersSaved.promise;
        await new Promise((resolve) => setImmediate(resolve));
        service.pause();
        await assert.rejects(request, SyncResetError);
        body.enqueue(new TextEncoder().encode("{}"));
        body.close();
    });
}

test("pause waits for a checkpoint save already in progress", async () => {
    const saving = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let settled = false;
    let checkpoint: string | undefined;
    const service = new SyncService(
        "device",
        settings(),
        async () =>
            Response.json(
                {},
                {
                    headers: { "X-Vault-Link-History": "1:head" }
                }
            ),
        {
            get: () => checkpoint,
            save: async (value) => {
                saving.resolve();
                await release.promise;
                checkpoint = value;
            }
        }
    );
    service.resume();
    const request = service.events(0).finally(() => {
        settled = true;
    });
    await saving.promise;
    service.pause();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    release.resolve();
    await assert.rejects(request, SyncResetError);
    assert.equal(checkpoint, "1:head");
});

test("history saves only new checkpoints, including a changed token at the same event ID", async () => {
    let checkpoint: string | undefined;
    let responseCheckpoint = "1:first";
    const saved: (string | undefined)[] = [];
    const service = new SyncService(
        "device",
        settings(),
        async () =>
            Response.json(
                {},
                { headers: { "X-Vault-Link-History": responseCheckpoint } }
            ),
        {
            get: () => checkpoint,
            save: async (value) => {
                checkpoint = value;
                saved.push(value);
            }
        }
    );
    service.resume();
    for (const value of [
        "1:first",
        "1:first",
        "2:next",
        "1:first",
        "2:replacement",
        "2:replacement"
    ]) {
        responseCheckpoint = value;
        await service.events(0);
    }
    assert.deepEqual(saved, ["1:first", "2:next", "2:replacement"]);
});
