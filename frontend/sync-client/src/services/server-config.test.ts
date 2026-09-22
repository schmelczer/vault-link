import assert from "node:assert/strict";
import { test } from "node:test";
import { ServerConfig } from "./server-config";
import { SyncService } from "./sync-service";
import { Settings } from "../persistence/settings";
import { Logger } from "../tracing/logger";
import { SUPPORTED_API_VERSION } from "../consts";

const config = {
    supportedApiVersion: SUPPORTED_API_VERSION,
    isAuthenticated: true,
    mergeableFileExtensions: ["md"],
    serverVersion: "test"
};
const make = (fetch: typeof globalThis.fetch) =>
    new ServerConfig(
        new SyncService(
            "device",
            new Settings(
                new Logger(),
                { remoteUri: "http://test" },
                async () => {}
            ),
            fetch
        )
    );

test("configuration shares one validated request and retries failures", async () => {
    let calls = 0;
    const server = make(async () => {
        if (++calls === 1) throw new Error("offline");
        return Response.json(config);
    });
    await assert.rejects(server.getConfig(), /offline/);
    const [a, b] = await Promise.all([server.getConfig(), server.getConfig()]);
    assert.equal(a, b);
    assert.equal(calls, 2);
    await server.getConfig();
    assert.equal(calls, 2);
});

test("connection checks are independent and validate authentication and version", async () => {
    let response = config;
    const server = make(async () => Response.json(response));
    const cached = await server.getConfig();
    response = { ...config, isAuthenticated: false };
    assert.equal((await server.checkConnection()).isSuccessful, false);
    response = { ...config, supportedApiVersion: SUPPORTED_API_VERSION + 1 };
    assert.equal((await server.checkConnection()).isSuccessful, false);
    assert.equal(await server.getConfig(), cached);
    server.reset();
    await assert.rejects(server.getConfig(), /Unsupported API/);
    response = config;
    assert.deepEqual(await server.getConfig(), config);
});

for (const fail of [false, true]) {
    test(`reset fences a late ${fail ? "failed" : "successful"} configuration request`, async () => {
        const first = Promise.withResolvers<Response>();
        let calls = 0;
        const server = make(async () =>
            ++calls === 1 ? first.promise : Response.json(config)
        );
        const old = server.getConfig();
        server.reset();
        const current = await server.getConfig();
        if (fail) {
            first.reject(new Error("old request"));
            await assert.rejects(old, /old request/);
        } else {
            first.resolve(
                Response.json({ ...config, mergeableFileExtensions: ["txt"] })
            );
            await old;
        }
        assert.equal(await server.getConfig(), current);
        assert.equal(calls, 2);
    });
}
