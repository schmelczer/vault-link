import { describe, it } from "node:test";
import assert from "node:assert";
import { Logger, LogLevel } from "../tracing/logger";
import { Settings } from "../persistence/settings";
import {
    STORED_STATE_SCHEMA_VERSION,
    SyncEventQueue
} from "./sync-event-queue";
import { Reconciler } from "./reconciler";
import { SyncResetError } from "../errors/sync-reset-error";
import type { FileOperations } from "../file-operations/file-operations";
import type { SyncService } from "../services/sync-service";
import type { RelativePath } from "./types";

describe("Reconciler", () => {
    it("does not emit an error when placement fetch is interrupted by reset", async () => {
        const logger = new Logger();
        const settings = new Settings(logger, {}, async () => {
            /* no-op */
        });
        const queue = new SyncEventQueue(
            settings,
            logger,
            { schemaVersion: STORED_STATE_SCHEMA_VERSION },
            async () => {
                /* no-op */
            }
        );

        await queue.upsertRecord({
            documentId: "DOC-1",
            parentVersionId: 1,
            remoteHash: "hash",
            remoteRelativePath: "remote.md" as RelativePath,
            localPath: undefined
        });

        const operationsPartial: Partial<FileOperations> = {
            exists: async () => false,
            create: async () => {
                assert.fail("reset-interrupted placement should not write");
            }
        };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const operations = operationsPartial as FileOperations;

        const syncServicePartial: Partial<SyncService> = {
            getDocumentVersionContent: async () => {
                throw new SyncResetError();
            }
        };
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const syncService = syncServicePartial as SyncService;

        const reconciler = new Reconciler(
            logger,
            operations,
            syncService,
            queue,
            new Map()
        );

        await reconciler.run();

        assert.deepStrictEqual(logger.getMessages(LogLevel.ERROR), []);
        assert.ok(
            logger
                .getMessages(LogLevel.INFO)
                .some((line) =>
                    line.message.includes(
                        "content fetch for DOC-1 interrupted by sync reset"
                    )
                )
        );
    });
});
