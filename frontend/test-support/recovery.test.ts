import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { MemoryDisk, MemoryPersistence } from "./storage";
import {
    Database,
    emptyState,
    type StoredDatabase
} from "../sync-client/src/persistence/database";
import { FileOperations } from "../sync-client/src/file-operations/file-operations";
import { toStoredSnapshot } from "../sync-client/src/sync-operations/content";
import { Logger } from "../sync-client/src/tracing/logger";
import type { ServerConfig } from "../sync-client/src/services/server-config";
import { mergeFileManifests } from "../sync-client/src/sync-operations/file-manifest";
import { assertManifest, pathDecision } from "./oracles";
import {
    scanLocalFiles,
    type LocalChange
} from "../sync-client/src/sync-operations/scan";

const bytes = (text: string) => new TextEncoder().encode(text);
const config = {
    getConfig: async () => ({ mergeableFileExtensions: ["md"] })
} as ServerConfig;

async function fixture(
    contents: Record<string, { path: string; text: string }> = {
        a: { path: "a.md", text: "A" },
        b: { path: "b.md", text: "B" }
    }
) {
    const disk = new MemoryDisk();
    const initial = emptyState("recovery-test");
    for (const [id, { path, text }] of Object.entries(contents)) {
        await disk.userWrite(path, bytes(text));
        initial.local[id] = path;
    }
    for (const [id, path] of Object.entries(initial.local))
        initial.documents[id] = {
            materialized: true,
            observedHash: (
                await toStoredSnapshot((await disk.readSnapshot(path))!)
            ).hash
        };
    const persistence = new MemoryPersistence({ database: initial });
    const restart = (changes: LocalChange[] = []) => {
        const database = new Database(
            new Logger(),
            persistence.snapshot().database,
            async (next) => persistence.save({ database: next }),
            "recovery-test",
            async () => (await persistence.load()).database as StoredDatabase
        );
        return {
            database,
            files: new FileOperations(
                disk.session(),
                database,
                config,
                undefined,
                { entries: () => changes, flush: async () => {} }
            )
        };
    };
    return {
        disk,
        persistence,
        restart,
        initial,
        permanentFault: (_label: string): void => {},
        expectedLocal: undefined as Record<string, string> | undefined
    };
}

async function swapFixture() {
    const current = await fixture();
    const next = structuredClone(current.initial);
    next.local = { a: "b.md", b: "a.md", c: "nested/c.md" };
    next.documents.c = { materialized: false };
    const writes = {
        c: { replacement: await toStoredSnapshot({ content: bytes("C") }) }
    };
    const expected = new Map([
        ["a.md", bytes("B")],
        ["b.md", bytes("A")],
        ["nested/c.md", bytes("C")]
    ]);
    return { ...current, next, writes, expected, retained: [] as string[] };
}

async function crossDirectoryFixture() {
    const current = await fixture({
        a: { path: "src/a.md", text: "A" },
        // Keep src nonempty: deleting an empty source directory would mask an
        // unflushed source unlink in the staging rename.
        b: { path: "src/keep.md", text: "untouched sibling" }
    });
    const next = structuredClone(current.initial);
    next.local.a = "dst/a.md";
    const expected = new Map([
        ["dst/a.md", bytes("A")],
        ["src/keep.md", bytes("untouched sibling")]
    ]);
    return { ...current, next, writes: {}, expected, retained: [] as string[] };
}

async function mergeFixture() {
    const base = "first paragraph\n\nlast paragraph\n";
    const local = "local first paragraph\n\nlast paragraph\n";
    const remote = "first paragraph\n\nremote last paragraph\n";
    const current = await fixture({ a: { path: "note.md", text: local } });
    return {
        ...current,
        next: structuredClone(current.initial),
        writes: {
            a: {
                expected: await toStoredSnapshot({ content: bytes(base) }),
                replacement: await toStoredSnapshot({ content: bytes(remote) })
            }
        },
        expected: new Map([
            [
                "note.md",
                bytes("local first paragraph\n\nremote last paragraph\n")
            ]
        ]),
        retained: [local]
    };
}

async function deletionFixture() {
    const current = await fixture({
        a: { path: "a.bin", text: "private binary edit\0" },
        b: { path: "deleted.md", text: "unsent deleted bytes" }
    });
    const next = structuredClone(current.initial);
    delete next.local.b;
    return {
        ...current,
        next,
        writes: {
            a: {
                replacement: await toStoredSnapshot({
                    content: bytes("remote binary\0")
                })
            }
        },
        expected: new Map([["a.bin", bytes("remote binary\0")]]),
        retained: ["private binary edit\0", "unsent deleted bytes"]
    };
}

async function permanentDestinationFixture() {
    const current = await fixture();
    const next = structuredClone(current.initial);
    next.local = { a: "unsupported/a.md", b: "good.md" };
    return {
        ...current,
        next,
        permanentFault: (label: string) => {
            if (label === "before:mkdir:unsupported")
                throw Object.assign(new Error("Unsupported destination"), {
                    code: "ENAMETOOLONG"
                });
        },
        writes: {
            a: {
                expected: await toStoredSnapshot({ content: bytes("A") }),
                replacement: await toStoredSnapshot({
                    content: bytes("REMOTE")
                })
            }
        },
        expectedLocal: { a: "Recovered a.md", b: "good.md" },
        expected: new Map([
            ["Recovered a.md", bytes("REMOTE")],
            ["good.md", bytes("B")]
        ]),
        retained: ["A"]
    };
}

for (const [name, create] of [
    ["swap and create", swapFixture],
    ["cross-directory move with surviving sibling", crossDirectoryFixture],
    ["merge during recovery", mergeFixture],
    ["binary replacement, deletion and retained bytes", deletionFixture],
    ["permanent destination replan", permanentDestinationFixture]
] as const) {
    test(`${name}: interrupt every apply and replay boundary, then power-cycle again`, async (t) => {
        const baseline = await create();
        const labels: string[] = [];
        const trace = (label: string) => {
            if (!label.startsWith("read:")) labels.push(label);
        };
        baseline.disk.boundary = (label) => {
            baseline.permanentFault(label);
            trace(label);
        };
        baseline.persistence.boundary = trace;
        await baseline.restart().files.apply(baseline.next, baseline.writes);
        assert.deepEqual(baseline.disk.userFiles(), baseline.expected);
        assert(labels.some((label) => label.startsWith("visible:rename:")));
        assert(labels.includes("durable:save"));
        let replayCrashes = 0;
        for (const powerLoss of [false, true]) {
            for (let index = 0; index < labels.length; index++) {
                await t.test(
                    `${powerLoss ? "power" : "process"} crash #${index}: ${labels[index]}`,
                    async () => {
                        const current = await create();
                        const clearFaults = () => {
                            current.disk.boundary = current.permanentFault;
                            current.persistence.boundary = () => {};
                        };
                        const interrupt = async (
                            action: () => Promise<void>,
                            at: number,
                            power: boolean
                        ) => {
                            let position = 0,
                                fired = false;
                            const fault = (label: string) => {
                                if (label.startsWith("read:")) return;
                                if (position++ === at) {
                                    fired = true;
                                    current.disk.crash(power);
                                    throw new Error("Injected interruption");
                                }
                            };
                            current.disk.boundary = (label) => {
                                current.permanentFault(label);
                                fault(label);
                            };
                            current.persistence.boundary = fault;
                            try {
                                await assert.rejects(
                                    action(),
                                    /Injected interruption/
                                );
                                assert(fired, "Fault index did not occur");
                            } finally {
                                clearFaults();
                            }
                        };
                        const verify = (
                            runtime: ReturnType<typeof current.restart>
                        ) => {
                            assert.equal(
                                runtime.database.state.application,
                                undefined
                            );
                            assert.deepEqual(
                                runtime.database.state.local,
                                current.expectedLocal ?? current.next.local
                            );
                            assert.deepEqual(
                                current.disk.userFiles(),
                                current.expected,
                                "Exact files must survive interrupted replay"
                            );
                            const retained = current.disk
                                .image()
                                .visible.filter(
                                    ([path, entry]) =>
                                        entry &&
                                        path.startsWith(
                                            ".vault-link-sync/recovery/"
                                        ) &&
                                        path.endsWith(".content")
                                )
                                .map(([, entry]) =>
                                    Buffer.from(entry!.content).toString()
                                )
                                .sort();
                            assert.deepEqual(
                                retained,
                                [...current.retained].sort(),
                                "Recovery archives lost or duplicated displaced bytes"
                            );
                            assert(
                                !current.disk
                                    .image()
                                    .visible.some(
                                        ([path, entry]) =>
                                            entry &&
                                            path.startsWith(
                                                ".vault-link-sync/transactions/"
                                            )
                                    ),
                                "Completed recovery left transaction artifacts"
                            );
                        };
                        const finish = async (resubmit: boolean) => {
                            let runtime = current.restart();
                            await runtime.files.recover();
                            if (resubmit)
                                await runtime.files.apply(
                                    current.next,
                                    current.writes
                                );
                            await runtime.files.recover();
                            verify(runtime);
                            current.disk.crash(true);
                            runtime = current.restart();
                            await runtime.files.recover();
                            verify(runtime);
                        };
                        await interrupt(
                            () =>
                                current
                                    .restart()
                                    .files.apply(current.next, current.writes),
                            index,
                            powerLoss
                        );
                        const saved = current.persistence.snapshot();
                        const diskImage = current.disk.image();
                        const intentWasNotSaved = isDeepStrictEqual(
                            saved.database,
                            current.initial
                        );
                        // Trace replay from the actual interrupted state, including
                        // recovery-only branches such as already-visible installs.
                        const replayLabels: string[] = [];
                        const traceReplay = (label: string) => {
                            if (!label.startsWith("read:"))
                                replayLabels.push(label);
                        };
                        current.disk.boundary = (label) => {
                            current.permanentFault(label);
                            traceReplay(label);
                        };
                        current.persistence.boundary = traceReplay;
                        await current.restart().files.recover();
                        clearFaults();
                        await finish(intentWasNotSaved);
                        for (const secondPowerLoss of [false, true]) {
                            for (
                                let replay = 0;
                                replay < replayLabels.length;
                                replay++
                            ) {
                                current.disk.crash();
                                current.disk.restore(diskImage);
                                await current.persistence.save(saved);
                                try {
                                    await interrupt(
                                        () => current.restart().files.recover(),
                                        replay,
                                        secondPowerLoss
                                    );
                                    await finish(false);
                                    replayCrashes++;
                                } catch (error) {
                                    throw new Error(
                                        `Second ${secondPowerLoss ? "power" : "process"} crash #${replay}: ${replayLabels[replay]}`,
                                        { cause: error }
                                    );
                                }
                            }
                        }
                    }
                );
            }
        }
        assert(replayCrashes > 0, "No interrupted recovery was exercised");
        t.diagnostic(`${replayCrashes} second crashes during journal replay`);
    });
}

test("production manifest merge obeys independently specified per-document policy", () => {
    const paths = [undefined, "a.md", "b.md", "nested/c.md"];
    const map = (path: string | undefined): Record<string, string> =>
        path === undefined
            ? {}
            : { "00000000-0000-4000-8000-000000000001": path };
    for (const base of paths)
        for (const local of paths)
            for (const remote of paths) {
                assert.deepEqual(
                    mergeFileManifests(map(base), map(local), map(remote)),
                    map(pathDecision(base, local, remote))
                );
            }
    const conflicts = mergeFileManifests(
        {},
        { a: "folder" },
        { b: "folder/note.md" }
    );
    assertManifest(conflicts);
    assert.equal(
        conflicts.b,
        "folder/note.md",
        "Canonical path must win collision"
    );
    assert.equal(
        Object.keys(conflicts).length,
        2,
        "Collision must not discard an ID"
    );
});

test("exhaustive two-document manifest states preserve IDs and canonical collision priority", () => {
    const ids = [
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002"
    ];
    const states: Record<string, string>[] = [];
    for (const a of [undefined, "a.md", "b.md"])
        for (const b of [undefined, "a.md", "b.md"]) {
            if (a && a === b) continue;
            states.push({
                ...(a ? { [ids[0]]: a } : {}),
                ...(b ? { [ids[1]]: b } : {})
            });
        }
    for (const base of states)
        for (const local of states)
            for (const remote of states) {
                const expected = Object.fromEntries(
                    ids
                        .map((id) => [
                            id,
                            pathDecision(base[id], local[id], remote[id])
                        ])
                        .filter(([, value]) => value !== undefined)
                );
                const merged = mergeFileManifests(base, local, remote);
                assertManifest(merged);
                assert.deepEqual(
                    Object.keys(merged).sort(),
                    Object.keys(expected).sort(),
                    "Merge discarded or invented an identity"
                );
                for (const id of ids)
                    if (
                        expected[id] !== undefined &&
                        remote[id] === expected[id]
                    )
                        assert.equal(
                            merged[id],
                            remote[id],
                            "Canonical claimant lost its path"
                        );
                assert.deepEqual(
                    mergeFileManifests(remote, merged, remote),
                    merged,
                    "Manifest merge is not idempotent"
                );
            }
});

test("scan failures cannot masquerade as deletions", async () => {
    for (const point of ["read:list:", "read:snapshot:a.md"]) {
        const current = await fixture();
        const runtime = current.restart();
        const original = structuredClone(runtime.database.state);
        let fired = false;
        current.disk.boundary = (label) => {
            if (label === point) {
                fired = true;
                throw new Error("permission denied");
            }
        };
        await assert.rejects(
            scanLocalFiles({
                next: structuredClone(original),
                changes: [],
                files: runtime.files,
                guard: () => {},
                ignored: () => false,
                oversized: () => false,
                commit: (next) => runtime.database.commit(next)
            }),
            /permission denied/
        );
        assert(fired);
        assert.deepEqual(runtime.database.state, original);
        assert.deepEqual(current.persistence.snapshot().database, original);
    }
});

for (const phase of ["before", "durable"]) {
    test(`delete/recreate identity survives ${phase}-save failure and retry`, async () => {
        const current = await fixture();
        await current.disk.userDelete("a.md");
        await current.disk.userWrite("a.md", bytes("new incarnation"));
        const changes: LocalChange[] = [
            { type: "delete", path: "a.md" },
            { type: "create", path: "a.md" }
        ];
        const scan = async () => {
            const runtime = current.restart();
            await scanLocalFiles({
                next: structuredClone(runtime.database.state),
                changes,
                files: runtime.files,
                guard: () => {},
                ignored: () => false,
                oversized: () => false,
                commit: (next) => runtime.database.commit(next)
            });
            return runtime.database.state;
        };
        current.persistence.boundary = (label) => {
            if (label === `${phase}:save`) throw new Error("save failure");
        };
        await assert.rejects(scan(), /save failure/);
        current.persistence.boundary = () => {};
        const state = await scan();
        assert.equal(
            state.local.a,
            undefined,
            "Retry reused the deleted document's UUID"
        );
        assert.equal(
            Object.values(state.local).filter((path) => path === "a.md").length,
            1
        );
    });
}

async function scanChanges(
    runtime: { database: Database; files: FileOperations },
    changes: LocalChange[]
): Promise<void> {
    await runtime.database.recoverPersistence();
    await scanLocalFiles({
        next: structuredClone(runtime.database.state),
        changes,
        files: runtime.files,
        guard: () => {},
        ignored: () => false,
        oversized: () => false,
        commit: (next) => runtime.database.commit(next)
    });
}

for (const editedContent of ["new bytes", "B"]) {
    test(`explicit rename then edit to ${JSON.stringify(editedContent)} preserves both UUIDs`, async () => {
        const current = await fixture();
        const runtime = current.restart();
        await current.disk.userRename("a.md", "moved.md");
        await current.disk.userWrite("moved.md", bytes(editedContent));
        const changes: LocalChange[] = [
            { type: "move", oldPath: "a.md", relativePath: "moved.md" }
        ];
        await scanChanges(runtime, changes);
        assert.deepEqual(
            runtime.database.state.local,
            { a: "moved.md", b: "b.md" },
            "Matching another live document's bytes must not steal its UUID"
        );
        assert.deepEqual(
            current.disk.userFiles(),
            new Map([
                ["moved.md", bytes(editedContent)],
                ["b.md", bytes("B")]
            ])
        );
        assert.equal(changes.length, 0);
    });
}

for (const equalContent of [false, true]) {
    for (const phase of ["before", "durable"]) {
        test(`${equalContent ? "equal" : "different"}-content swap retains UUIDs after ${phase}-save rejection`, async () => {
            const current = await fixture({
                a: { path: "a.md", text: "A" },
                b: { path: "b.md", text: equalContent ? "A" : "B" }
            });
            const runtime = current.restart();
            const changes: LocalChange[] = [];
            for (const [oldPath, relativePath] of [
                ["a.md", "temporary.md"],
                ["b.md", "a.md"],
                ["temporary.md", "b.md"]
            ]) {
                await current.disk.userRename(oldPath, relativePath);
                changes.push({ type: "move", oldPath, relativePath });
            }
            const expected = { a: "b.md", b: "a.md" };
            const expectedFiles = new Map([
                ["a.md", bytes(equalContent ? "A" : "B")],
                ["b.md", bytes("A")]
            ]);
            let fired = false;
            current.persistence.boundary = (label) => {
                if (!fired && label === `${phase}:save`) {
                    fired = true;
                    throw new Error("uncertain save");
                }
            };
            await assert.rejects(
                scanChanges(runtime, changes),
                /uncertain save/
            );
            assert(fired, "The requested save failure must be exercised");
            assert.deepEqual(
                current.persistence.snapshot().database!.local,
                phase === "durable" ? expected : current.initial.local,
                "The fault must occur on the intended side of the durable save"
            );
            current.persistence.boundary = () => {};
            // Model an uncertain save in a live client: durable state reloads,
            // but the original editor notifications remain in memory. Do not
            // clear, reconstruct or deduplicate that queue in the harness.
            await scanChanges(runtime, changes);
            assert.deepEqual(
                runtime.database.state.local,
                expected,
                "Retry replayed an already committed swap and reversed its identities"
            );
            assert.equal(changes.length, 0);
            await scanChanges(runtime, changes);
            assert.deepEqual(runtime.database.state.local, expected);
            const restarted = current.restart();
            await scanChanges(restarted, []);
            assert.deepEqual(restarted.database.state.local, expected);
            assert.deepEqual(current.disk.userFiles(), expectedFiles);
        });
    }
}

test("normalization-sensitive disk does not lose a distinct decomposed filename", async () => {
    const current = await fixture();
    await current.disk.userWrite("é.md", bytes("composed"));
    const runtime = current.restart();
    const next = structuredClone(runtime.database.state);
    next.local.composed = "é.md";
    next.documents.composed = { materialized: true };
    await runtime.database.commit(next);
    await current.disk.userWrite("e\u0301.md", bytes("decomposed"));
    await scanLocalFiles({
        next: structuredClone(runtime.database.state),
        changes: [],
        files: runtime.files,
        guard: () => {},
        ignored: () => false,
        oversized: () => false,
        commit: (next) => runtime.database.commit(next)
    });
    assert.equal(
        Object.keys(runtime.database.state.local).length,
        4,
        "Distinct Unicode file vanished from the scan"
    );
});

test("notified editor move during a remote swap keeps the moved document's UUID", async () => {
    const current = await fixture();
    const changes: LocalChange[] = [];
    const runtime = current.restart(changes);
    let fired = false;
    current.persistence.boundary = async (label) => {
        if (
            !fired &&
            label === "durable:save" &&
            current.persistence.snapshot().database?.application
        ) {
            fired = true;
            await current.disk.userRename("b.md", "editor.md");
            changes.push({
                type: "move",
                oldPath: "b.md",
                relativePath: "editor.md"
            });
        }
    };
    const next = structuredClone(runtime.database.state);
    next.local = { a: "b.md", b: "a.md" };
    await runtime.files.apply(next);
    assert(fired);
    await scanLocalFiles({
        next: structuredClone(runtime.database.state),
        changes,
        files: runtime.files,
        guard: () => {},
        ignored: () => false,
        oversized: () => false,
        commit: (next) => runtime.database.commit(next)
    });
    assert.equal(
        runtime.database.state.local.b,
        "editor.md",
        "Editor move was attributed to the wrong document"
    );
    assert.equal(
        Buffer.from(
            current.disk.userFiles().get(runtime.database.state.local.b)!
        ).toString(),
        "B"
    );
});
