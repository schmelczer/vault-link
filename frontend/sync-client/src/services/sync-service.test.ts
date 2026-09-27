import { HISTORY_HEADER } from "../consts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Settings } from "../persistence/settings";
import { Logger } from "../tracing/logger";
import { SyncResetError } from "../errors/errors";
import { SyncService } from "./sync-service";

const settings = (): Settings =>
    new Settings(
        new Logger(),
        {
            remoteUri: "http://test",
            vaultName: "test",
            requestTimeoutMs: 1000
        },
        async () => undefined
    );

test("paused sync sends no requests, while connection checks still work", async (): Promise<void> => {
    let requests = 0;
    const service = new SyncService(
        "device",
        settings(),
        async () => {
            requests++;
            return Response.json(
                { headEventId: 0, endEventId: 0, events: [] },
                { headers: { [HISTORY_HEADER]: "0:empty" } }
            );
        },
        {
            get: (): undefined => undefined,
            save: async (): Promise<void> => undefined
        }
    );
    await assert.rejects(service.getEvents(0), SyncResetError);
    assert.equal(requests, 0);
    await service.getServerConfig();
    assert.equal(requests, 1);
    service.resume();
    assert.equal((await service.getEvents(0)).headEventId, 0);
    assert.equal(requests, 2);
});

test("pause aborts requests and fences late responses from an injected fetch", async (): Promise<void> => {
    const response = Promise.withResolvers<Response>();
    const signals: AbortSignal[] = [];
    const saved: (string | undefined)[] = [];
    const service = new SyncService(
        "device",
        settings(),
        async (_, init) => {
            assert.ok(init?.signal);
            signals.push(init.signal);
            return signals.length === 1
                ? response.promise
                : Response.json(
                      { headEventId: 0, endEventId: 0, events: [] },
                      { headers: { [HISTORY_HEADER]: "0:empty" } }
                  );
        },
        {
            get: (): undefined => undefined,
            save: async (value): Promise<void> => {
                saved.push(value);
            }
        }
    );
    service.resume();
    const first = service.getEvents(0);
    service.pause();
    await assert.rejects(first, SyncResetError);
    assert.equal(signals[0]?.aborted, true);
    service.resume();
    await service.getEvents(0);
    assert.equal(signals[1]?.aborted, false);
    response.resolve(
        Response.json({}, { headers: { [HISTORY_HEADER]: "99:abandoned" } })
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(saved, ["0:empty"]);
});

for (const binary of [false, true]) {
    test(`pause interrupts a stalled ${binary ? "binary" : "JSON"} response body`, async (): Promise<void> => {
        const headersSaved = Promise.withResolvers<undefined>();
        const bodyReady =
            Promise.withResolvers<
                ReadableStreamDefaultController<Uint8Array>
            >();
        const service = new SyncService(
            "device",
            settings(),
            async () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        start(controller): void {
                            bodyReady.resolve(controller);
                        }
                    }),
                    { headers: { [HISTORY_HEADER]: "1:head" } }
                ),
            {
                get: (): undefined => undefined,
                save: async (): Promise<void> => {
                    headersSaved.resolve(undefined);
                }
            }
        );
        service.resume();
        const request = binary
            ? service.getDocumentVersionContent({
                  documentId: "a",
                  vaultUpdateId: 1
              })
            : service.getEvents(0);
        await headersSaved.promise;
        await new Promise((resolve) => setImmediate(resolve));
        service.pause();
        await assert.rejects(request, SyncResetError);
        const body = await bodyReady.promise;
        body.enqueue(new TextEncoder().encode("{}"));
        body.close();
    });
}

test("pause waits for a checkpoint save already in progress", async (): Promise<void> => {
    const saving = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let settled = false;
    let checkpoint: string | undefined = undefined;
    const service = new SyncService(
        "device",
        settings(),
        async () =>
            Response.json(
                {},
                {
                    headers: { [HISTORY_HEADER]: "1:head" }
                }
            ),
        {
            get: (): string | undefined => checkpoint,
            save: async (value): Promise<void> => {
                saving.resolve(undefined);
                await release.promise;
                checkpoint = value;
            }
        }
    );
    service.resume();
    const request = service.getEvents(0).finally(() => {
        settled = true;
    });
    await saving.promise;
    service.pause();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    release.resolve(undefined);
    await assert.rejects(request, SyncResetError);
    assert.equal(checkpoint, "1:head");
});

test("history saves only new checkpoints, including a changed token at the same event ID", async (): Promise<void> => {
    let checkpoint: string | undefined = undefined;
    let responseCheckpoint = "1:first";
    const saved: (string | undefined)[] = [];
    const service = new SyncService(
        "device",
        settings(),
        async () =>
            Response.json(
                {},
                { headers: { [HISTORY_HEADER]: responseCheckpoint } }
            ),
        {
            get: (): string | undefined => checkpoint,
            save: async (value): Promise<void> => {
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
        await service.getEvents(0);
    }

    assert.deepEqual(saved, ["1:first", "2:next", "2:replacement"]);
});

for (const checkpoint of [undefined, ""]) {
    test(`successful sync responses reject ${checkpoint === undefined ? "missing" : "empty"} history checkpoints`, async () => {
        const service = new SyncService(
            "device",
            settings(),
            async () =>
                Response.json(
                    { headEventId: 0, endEventId: 0, events: [] },
                    {
                        headers:
                            checkpoint === undefined
                                ? {}
                                : { [HISTORY_HEADER]: checkpoint }
                    }
                ),
            {
                get: (): undefined => undefined,
                save: async (): Promise<void> => {
                    assert.fail("must not save a missing checkpoint");
                }
            }
        );
        service.resume();
        await assert.rejects(
            service.getEvents(0),
            /Missing server history checkpoint/
        );
    });
}

test("server configuration uses GET /config even when synchronization is paused", async () => {
    const config = {
        supportedApiVersion: 4,
        serverVersion: "test",
        isAuthenticated: true,
        mergeableFileExtensions: ["md"]
    };
    const service = new SyncService(
        "device",
        settings(),
        async (input, init) => {
            assert.equal(input, "http://test/vaults/test/config");
            assert.equal(init?.method, "GET");
            assert.equal(init.body, undefined);
            assert.equal(new Headers(init.headers).has(HISTORY_HEADER), false);
            return Response.json(config);
        },
        {
            get: (): string => "10:old-history",
            save: async (): Promise<void> => {
                assert.fail("Config must not update the sync checkpoint");
            }
        }
    );
    assert.deepEqual(await service.getServerConfig(), config);
});
