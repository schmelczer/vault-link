import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Settings, type SyncSettings } from "../persistence/settings";
import { Logger } from "../tracing/logger";
import { PermanentSyncError } from "../errors/errors";
import { SyncPhase, SyncScheduler } from "./sync-scheduler";

function createScheduler(
    overrides: Partial<SyncSettings> = {},
    pass: () => Promise<void> = async () => undefined
): { scheduler: SyncScheduler; runCount: () => number } {
    let runs = 0;
    const scheduler = new SyncScheduler(
        new Settings(new Logger(), overrides, async () => undefined),
        async () => {
            do {
                scheduler.beginPass();
                runs++;
                await pass();
            } while (scheduler.needsAnotherPass);
        },
        () => undefined,
        () => false
    );
    return { scheduler, runCount: () => runs };
}

describe("Sync scheduler transitions", () => {
    beforeEach(() => {
        mock.timers.enable({ apis: ["setTimeout"] });
    });
    afterEach(() => {
        mock.timers.reset();
    });

    for (const interval of [undefined, 0]) {
        it(`leaves polling disabled for interval ${interval}`, async () => {
            const { scheduler, runCount } = createScheduler({
                syncIntervalMs: interval
            });
            scheduler.start();
            await scheduler.waitUntilFinished();
            assert.equal(scheduler.currentPhase, SyncPhase.Idle);
            mock.timers.tick(60_000);
            assert.equal(runCount(), 1);
            await scheduler.stop();
            assert.equal(scheduler.currentPhase, SyncPhase.Stopped);
        });
    }

    it("polls after the configured interval and cancels the timer on stop", async () => {
        const { scheduler, runCount } = createScheduler({ syncIntervalMs: 25 });
        scheduler.start();
        await scheduler.waitUntilFinished();
        mock.timers.tick(24);
        assert.equal(runCount(), 1);
        mock.timers.tick(1);
        assert.equal(runCount(), 2);
        await scheduler.waitUntilFinished();
        await scheduler.stop();
        mock.timers.tick(25);
        assert.equal(runCount(), 2);
    });

    it("coalesces notifications during a pass without running concurrently", async () => {
        const gate = Promise.withResolvers<undefined>();
        const { scheduler, runCount } = createScheduler(
            {},
            async () => gate.promise
        );
        scheduler.start();
        assert.equal(scheduler.currentPhase, SyncPhase.Running);
        scheduler.requestSync();
        scheduler.requestSync();
        assert.equal(scheduler.currentPhase, SyncPhase.RunRequested);
        assert.equal(runCount(), 1);
        gate.resolve(undefined);
        await scheduler.waitUntilFinished();
        assert.equal(runCount(), 2);
        assert.equal(scheduler.currentPhase, SyncPhase.Idle);
        await scheduler.stop();
    });

    it("drains an active pass on stop and discards queued notifications", async () => {
        const gate = Promise.withResolvers<undefined>();
        const { scheduler, runCount } = createScheduler(
            {},
            async () => gate.promise
        );
        scheduler.start();
        scheduler.requestSync();
        const stopped = scheduler.stop();
        assert.equal(scheduler.currentPhase, SyncPhase.Stopping);
        scheduler.requestSync();
        gate.resolve(undefined);
        await stopped;
        assert.equal(scheduler.currentPhase, SyncPhase.Stopped);
        assert.equal(runCount(), 1);
    });

    it("retries transient failures and returns to idle on success", async () => {
        let attempts = 0;
        const { scheduler } = createScheduler(
            { networkRetryIntervalMs: 10 },
            async () => {
                if (++attempts === 1) {
                    throw new Error("offline");
                }
            }
        );
        scheduler.start();
        await assert.rejects(scheduler.waitUntilFinished(), /offline/u);
        assert.equal(scheduler.currentPhase, SyncPhase.WaitingToRetry);
        mock.timers.tick(10);
        await scheduler.waitUntilFinished();
        assert.equal(scheduler.currentPhase, SyncPhase.Idle);
        assert.equal(attempts, 2);
        await scheduler.stop();
    });

    it("blocks automatic retries of permanent errors but accepts an explicit request", async () => {
        const { scheduler, runCount } = createScheduler(
            { networkRetryIntervalMs: 10 },
            async () => {
                throw new PermanentSyncError("rejected");
            }
        );
        scheduler.start();
        await assert.rejects(scheduler.waitUntilFinished(), /rejected/u);
        assert.equal(scheduler.currentPhase, SyncPhase.Blocked);
        mock.timers.tick(100);
        assert.equal(runCount(), 1);
        scheduler.requestSync();
        await assert.rejects(scheduler.waitUntilFinished(), /rejected/u);
        assert.equal(runCount(), 2);
        await scheduler.stop();
    });
});
