import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryDisk, MemoryPersistence } from "./storage";
import { NetworkFaults, classifyRequest } from "./network";
import {
    ContentLedger,
    assertManifest,
    assertSameFiles,
    pathDecision
} from "./oracles";
import { Random } from "./random";
import { TestRunner } from "../deterministic-tests/src/test-runner";
import type { ServerControl } from "../deterministic-tests/src/server-control";
import { Logger } from "sync-client";
import { ManagedWebSocketFactory } from "../deterministic-tests/src/managed-websocket";

const bytes = (text: string) => new TextEncoder().encode(text);

test("consistency oracle rejects self comparison, divergent paths and invalid UTF-8 bytes", () => {
    const first = new Map([["a.bin", new Uint8Array([0xff])]]);
    assert.throws(() => assertSameFiles([first, first]), /itself/);
    assert.throws(() =>
        assertSameFiles([first, new Map([["a.bin", new Uint8Array([0xfe])]])])
    );
    assert.throws(() => assertSameFiles([first, new Map()]));
    assertSameFiles([first, structuredClone(first)]);
});

test("ledger catches shared loss, duplicated bytes, and unrelated loss in delete workloads", () => {
    const ledger = new ContentLedger();
    ledger.add("first-marker");
    ledger.add("second-marker");
    ledger.removedBy("first-marker", "explicit delete of doc A");
    assert.throws(
        () => ledger.assertPreserved(new Map()),
        /second-marker.*lost/
    );
    assert.throws(
        () =>
            ledger.assertPreserved(
                new Map([["a", bytes("second-marker second-marker")]])
            ),
        /duplicated/
    );
    ledger.assertPreserved(new Map([["a", bytes("second-marker")]]));
});

test("memory adapter enforces v4 operations and snapshot ownership", async () => {
    const disk = new MemoryDisk();
    await disk.userWrite("folder/a", bytes("A"));
    const snap = (await disk.readSnapshot("folder/a"))!;
    snap.content[0] = 0;
    assert.equal(
        Buffer.from((await disk.readSnapshot("folder/a"))!.content).toString(),
        "A"
    );
    await assert.rejects(
        disk.write("folder/a", { content: bytes("B") }),
        /exists/
    );
    await disk.userWrite("folder/b", bytes("B"));
    await assert.rejects(disk.rename("folder/a", "folder/b"), /exists/);
    await assert.rejects(disk.delete("folder/a"), /regular file/);
    await assert.rejects(disk.delete("folder"), /regular file/);
    await assert.rejects(disk.readSnapshot("../outside"), /Unsafe/);
    await assert.rejects(disk.stat("folder/a/child"), /ancestor/);
    await assert.rejects(disk.readSnapshot("folder"), /directory/);
});

for (const phase of ["before", "visible", "durable"] as const) {
    for (const powerLoss of [false, true]) {
        test(`${powerLoss ? "power loss" : "process death"} at ${phase} rename boundary`, async () => {
            const disk = new MemoryDisk();
            await disk.userWrite("a", bytes("A"));
            const session = disk.session();
            let fired = false;
            disk.boundary = (label) => {
                if (label === `${phase}:rename:a->b`) {
                    fired = true;
                    disk.crash(powerLoss);
                    throw new Error("crash");
                }
            };
            await assert.rejects(session.rename("a", "b"), /crash/);
            assert(fired);
            disk.boundary = () => {};
            const moved =
                phase === "durable" || (phase === "visible" && !powerLoss);
            assert.deepEqual([...disk.userFiles().keys()], [moved ? "b" : "a"]);
            assert.throws(
                () => session.write("stale", { content: bytes("bad") }),
                /crashed/
            );
        });
    }
}

test("persistence has deep ownership and both old/new uncertain save outcomes", async () => {
    for (const phase of ["before", "durable"]) {
        const store = new MemoryPersistence({ settings: { vaultName: "old" } });
        const loaded = await store.load();
        loaded.settings!.vaultName = "mutated";
        assert.equal(store.snapshot().settings!.vaultName, "old");
        store.boundary = (label) => {
            if (label === `${phase}:save`) throw new Error("save failed");
        };
        await assert.rejects(
            store.save({ settings: { vaultName: "new" } }),
            /save failed/
        );
        assert.equal(
            store.snapshot().settings!.vaultName,
            phase === "before" ? "old" : "new"
        );
    }
});

test("CAS hooks match v4 create, update and manifest and preserve retry payload", async () => {
    for (const kind of ["create", "content", "manifest"] as const) {
        const net = new NetworkFaults();
        const url = `http://test/vaults/test/${kind === "manifest" ? "file-manifest" : "documents/uuid"}`;
        const body = {
            requestId: "same",
            parentVersionId: kind === "create" ? null : 3
        };
        const init = { method: "PUT", body: JSON.stringify(body) };
        assert.equal(classifyRequest(url, init)?.kind, kind);
        let committed = 0;
        const wrapped = net.wrap(async () => {
            committed++;
            return new Response('{"type":"Accepted"}');
        });
        net.arm(kind);
        await assert.rejects(wrapped(url, init), /Injected after-commit/);
        await net.wait();
        assert.throws(() => net.assertConsumed(), /never retried/);
        assert.equal(committed, 1);
        await wrapped(url, init);
        net.assertConsumed();
        await assert.rejects(
            wrapped(url, {
                ...init,
                body: JSON.stringify({ ...body, changed: true })
            }),
            /Retry changed/
        );
    }
    assert.equal(
        classifyRequest("http://test/documents", { method: "POST" }),
        undefined
    );
});

test("unconsumed and before-send faults cannot silently pass", async () => {
    const net = new NetworkFaults();
    net.arm("manifest", "before");
    assert.throws(() => net.assertConsumed(), /never fired/);
    let called = false;
    await assert.rejects(
        net.wrap(async () => {
            called = true;
            return new Response();
        })("http://test/file-manifest", {
            method: "PUT",
            body: '{"requestId":"r"}'
        })
    );
    assert(!called);
    assert.throws(() => net.assertConsumed(), /never retried/);
    await net.wrap(async () => new Response())("http://test/file-manifest", {
        method: "PUT",
        body: '{"requestId":"r"}'
    });
    net.assertConsumed();
});

test("HTTP observation checkpoint blocks catchup, resumes, and respects abort", async () => {
    const network = new NetworkFaults();
    const wrapped = network.wrap(async () => new Response("{}"));
    network.pauseObservation();
    let delivered = false;
    const request = wrapped("http://test/events-since?after=0").then(() => {
        delivered = true;
    });
    await network.waitForObservation();
    assert(!delivered, "Catchup bypassed the observation checkpoint");
    network.resumeObservation();
    await request;
    network.assertConsumed();
    network.pauseObservation();
    const controller = new AbortController();
    const interrupted = wrapped("http://test/vault-snapshot", {
        signal: controller.signal
    });
    const rejected = assert.rejects(interrupted, /abort/i);
    await network.waitForObservation();
    controller.abort();
    await rejected;
    network.resumeObservation();
    network.assertConsumed();
});

test("independent path decision truth table covers create, delete and rename", () => {
    for (const base of [undefined, "a", "b"])
        for (const local of [undefined, "a", "b"])
            for (const remote of [undefined, "a", "b"]) {
                const result = pathDecision(base, local, remote);
                assert.equal(result, remote !== base ? remote : local);
            }
    assertManifest({ a: "folder/é.md", b: "other.bin" });
    for (const entries of [
        { a: "A", b: "a" },
        { a: "é", b: "e\u0301" },
        { a: "x", b: "x/y" }
    ])
        assert.throws(() => assertManifest(entries));
});

test("seeded actions are repeatable, including seed zero", () => {
    for (const seed of [0, 1, 12345, 0xffffffff]) {
        const first = new Random(seed);
        const second = new Random(seed);
        assert.deepEqual(
            Array.from({ length: 100 }, () => first.int(100)),
            Array.from({ length: 100 }, () => second.int(100))
        );
    }
});

test("runner cleanup errors fail an otherwise successful test", async () => {
    const server = {
        isRunning: () => true,
        resume: () => {}
    } as unknown as ServerControl;
    const runner = new TestRunner(
        server,
        new Logger(),
        "unused",
        "http://unused"
    );
    let cleaned = 0;
    Object.assign(runner, {
        initializeAgents: async () => {},
        agents: [
            {
                clientId: 0,
                database: () => ({ evidence: "before cleanup" }),
                disk: { image: () => ({ bytes: [0, 255] }) },
                network: { requests: [{ body: { requestId: "original" } }] },
                cleanup: async () => {
                    cleaned++;
                    throw new Error("late background error");
                }
            }
        ]
    });
    const result = await runner.runTest("cleanup-probe", {
        clients: 2,
        steps: []
    });
    assert.equal(result.success, false);
    assert.match(result.error!, /late background error/);
    assert.equal(cleaned, 1, "Failed cleanup was run twice");
    assert.deepEqual(result.diagnostics, [
        {
            client: 0,
            database: { evidence: "before cleanup" },
            disk: { bytes: [0, 255] },
            requests: [{ body: { requestId: "original" } }]
        }
    ]);
});

test("disposed harness rejects late websocket reconnects", async () => {
    const factory = new ManagedWebSocketFactory();
    const Socket = factory.constructorFn;
    await factory.finish();
    assert.throws(() => new Socket("ws://unused"), /after harness cleanup/);
});

test("runner preserves primary failure and cleanup diagnostics", async () => {
    const server = {
        isRunning: () => true,
        resume: () => {}
    } as unknown as ServerControl;
    const runner = new TestRunner(
        server,
        new Logger(),
        "unused",
        "http://unused"
    );
    Object.assign(runner, {
        initializeAgents: async () => {},
        executeStep: async () => {
            throw new Error("primary assertion failed");
        },
        agents: [
            {
                clientId: 0,
                database: () => ({}),
                disk: { image: () => ({}) },
                network: { requests: [] },
                cleanup: async () => {
                    throw new Error("cleanup failed too");
                }
            }
        ]
    });
    const result = await runner.runTest("cleanup-probe", {
        clients: 2,
        steps: [{ type: "barrier" }]
    });
    assert.equal(result.success, false);
    assert.match(result.error!, /primary assertion failed/);
    assert.match(result.error!, /cleanup failed too/);
});
