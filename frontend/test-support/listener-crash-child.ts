import assert from "node:assert/strict";
import { fixture } from "./sync-fixture";
(async () => {
    const f = await fixture(
        {},
        {
            events: async () => ({ headEventId: 0, events: [] })
        }
    );
    let delivered = 0;
    f.syncer.onRemainingOperationsCountChanged.add(() => {
        throw new Error("observer failure");
    });
    f.syncer.onRemainingOperationsCountChanged.add(async () => {
        throw new Error("async observer failure");
    });
    f.syncer.onRemainingOperationsCountChanged.add(() => {
        delivered++;
    });
    try {
        f.syncer.start();
        await f.syncer.waitUntilFinished();
        const before = delivered;
        f.syncer.wake();
        await f.syncer.waitUntilFinished();
        assert(delivered > before, "Background sync must remain usable");
    } finally {
        await f.syncer.stop();
    }
})();
