import assert from "node:assert/strict";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ServerControl } from "../deterministic-tests/src/server-control";
import { Logger } from "sync-client";
import { SyncClient } from "../sync-client/src/sync-client";
import { MemoryDisk, MemoryPersistence } from "./storage";
const root = resolve(__dirname, "../..");
const token = "test-token-change-me";
export const bytes = (s: string) => new TextEncoder().encode(s);
const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Device-Id": "audit"
};
export async function fixture() {
    const server = new ServerControl(
        root + "/sync-server/target/release/sync_server",
        root + "/sync-server/config-e2e.yml",
        new Logger()
    );
    await server.start();
    const vault = randomUUID(),
        url = server.remoteUri + "/vaults/" + vault;
    const put = async (path: string, data: unknown) => {
        const r = await fetch(url + path, {
            method: "PUT",
            headers,
            body: JSON.stringify(data)
        });
        assert(r.ok, await r.clone().text());
        return r.json();
    };
    const get = async (path: string) => {
        const r = await fetch(url + path, { headers });
        assert(r.ok);
        return r.json();
    };
    const disk = new MemoryDisk();
    const store = new MemoryPersistence({
        settings: {
            remoteUri: server.remoteUri,
            vaultName: vault,
            token,
            isSyncEnabled: true,
            syncIntervalMs: 0,
            networkRetryIntervalMs: 0,
            requestTimeoutMs: 5000
        }
    });
    let fetchHook: typeof fetch | undefined;
    const createClient = () =>
        SyncClient.create({
            fs: disk,
            persistence: store,
            fetch: (...args) =>
                fetchHook ? fetchHook(...args) : fetch(...args)
        });
    let client = await createClient();
    const content = (text: string, parentVersionId: number | null = null) => ({
        requestId: randomUUID(),
        parentVersionId,
        content: {
            type: "Snapshot",
            value: Buffer.from(text).toString("base64")
        }
    });
    return {
        server,
        disk,
        store,
        get client() {
            return client;
        },
        reopenClient: async () => {
            await client.destroy();
            client = await createClient();
        },
        url,
        headers,
        put,
        get,
        content,
        setFetchHook: (hook: typeof fetch) => {
            fetchHook = hook;
        },
        dispose: async () => {
            await client.destroy();
            await server.stop();
        }
    };
}

export { randomUUID };
