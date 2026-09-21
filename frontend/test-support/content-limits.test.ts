import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, bytes, randomUUID } from "./sync-server-fixture";
test("stale manifest reconciliation must not fetch excluded remote content", async () => {
    const f = await fixture();
    try {
        const id = randomUUID(),
            big = randomUUID();
        await f.put("/documents/" + id, f.content("A"));
        const m = await f.put("/file-manifest", {
            requestId: randomUUID(),
            parentFileManifestId: 0,
            entries: { [id]: "a.md" }
        });
        await f.client.setSetting("maxFileSizeMB", 100 / (1024 * 1024));
        await f.client.start();
        await f.client.setSetting("isSyncEnabled", false);
        await f.disk.userRename("a.md", "renamed.md");
        await f.client.syncLocallyUpdatedFile({
            oldPath: "a.md",
            relativePath: "renamed.md"
        });
        let injected = false,
            downloaded = 0;
        f.setFetchHook(async (input, init) => {
            const path = String(input);
            if (
                !injected &&
                init?.method === "PUT" &&
                path.endsWith("/file-manifest")
            ) {
                injected = true;
                await f.put("/documents/" + big, f.content("B".repeat(4096)));
                await f.put("/file-manifest", {
                    requestId: randomUUID(),
                    parentFileManifestId: m.fileManifestId,
                    entries: { [id]: "a.md", [big]: "big.bin" }
                });
            }
            const response = await fetch(input, init);
            if (
                path.includes("/documents/" + big) &&
                !path.endsWith("/metadata") &&
                (!init?.method || init.method === "GET")
            )
                downloaded += (await response.clone().arrayBuffer()).byteLength;
            return response;
        });
        await f.client.setSetting("isSyncEnabled", true);

        assert(injected);
        assert(!f.disk.userFiles().has("big.bin"));
        assert.equal(downloaded, 0);
    } finally {
        await f.dispose();
    }
});

test("stale content acknowledgements contain metadata without the excluded payload", async () => {
    const f = await fixture();
    try {
        const id = randomUUID();
        await f.put("/documents/" + id, f.content("B".repeat(4096)));
        const stale = await f.put("/documents/" + id, f.content("LOCAL"));
        assert.equal(stale.type, "StaleBase");
        assert.equal(stale.contentSize, 4096);
        assert.equal(stale.contentBase64, undefined);
        const metadata = await f.get("/documents/" + id + "/metadata");
        assert.equal(metadata.contentSize, 4096);
        assert.equal(metadata.contentBase64, undefined);
    } finally {
        await f.dispose();
    }
});

test("highly fragmented local edits use a snapshot within the server operation budget", async () => {
    const { fixture } = await import("./sync-fixture");
    const { toStoredSnapshot } = await import(
        "../sync-client/src/sync-operations/content"
    );
    const f = await fixture({});
    f.contentCache.resize(1024 * 1024);
    const original = Array.from({ length: 12_000 }, (_, i) => `word${i}`).join(
        " "
    );
    const edited = Array.from({ length: 12_000 }, (_, i) =>
        i % 2 ? `changed${i}` : `word${i}`
    ).join(" ");
    f.contentCache.put(1, bytes(original));
    const syncer = f.syncer as unknown as {
        pushContent(
            path: string,
            version: number,
            snapshot: unknown
        ): Promise<{ type: string }>;
    };
    const request = await syncer.pushContent(
        "a.md",
        1,
        await toStoredSnapshot({ content: bytes(edited) })
    );
    assert.equal(request.type, "Snapshot");
});
