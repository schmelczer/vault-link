import type { TestDefinition } from "./test-definition";
import { writeWriteConflictTest } from "./tests/write-write-conflict.test";
import { renameCreateConflictTest } from "./tests/rename-create-conflict.test";
import { createDeleteNoopTest } from "./tests/create-delete-noop.test";
import { renameChainTest } from "./tests/rename-chain.test";
import { serverPauseResumeTest } from "./tests/server-pause-resume.test";
import { createMergeDeleteTest } from "./tests/create-merge-delete.test";
import { renameUpdateConflictTest } from "./tests/rename-update-conflict.test";
import { deleteRenameConflictTest } from "./tests/delete-rename-conflict.test";
import { multiFileOperationsTest } from "./tests/multi-file-operations.test";
import { duplicateContentFilesTest } from "./tests/duplicate-content-files.test";
import { deleteRecreateSamePathTest } from "./tests/delete-recreate-same-path.test";
import { rapidSyncToggleTest } from "./tests/rapid-sync-toggle.test";
import { concurrentDeleteUpdateTest } from "./tests/concurrent-delete-update.test";
import { offlineRenameAndEditTest } from "./tests/offline-rename-and-edit.test";
import { threeClientConvergenceTest } from "./tests/three-client-convergence.test";
import { updateDuringServerPauseTest } from "./tests/update-during-server-pause.test";
import { emptyFileSyncTest } from "./tests/empty-file-sync.test";
import { renameToExistingPathTest } from "./tests/rename-to-existing-path.test";
import { concurrentRenameSameTargetTest } from "./tests/concurrent-rename-same-target.test";
import { multipleUpdatesCoalesceTest } from "./tests/multiple-updates-coalesce.test";
import { deleteNonexistentFileTest } from "./tests/delete-nonexistent-file.test";
import { createWhileServerPausedTest } from "./tests/create-while-server-paused.test";
import { interleavedOperationsTest } from "./tests/interleaved-operations.test";
import { simultaneousCreateDeleteSamePathTest } from "./tests/simultaneous-create-delete-same-path.test";
import { largeFileCountTest } from "./tests/large-file-count.test";
import { offlineOperationsBothClientsTest } from "./tests/offline-operations-both-clients.test";
import { updateThenRenameTest } from "./tests/update-then-rename.test";
import { idempotencyAfterServerPauseTest } from "./tests/idempotency-after-server-pause.test";
import { concurrentCreateSamePathMergeTest } from "./tests/concurrent-create-same-path-merge.test";
import { sequentialCreateDuplicateContentTest } from "./tests/sequential-create-duplicate-content.test";
import { offlineMultiUpdateCatchupTest } from "./tests/offline-multi-update-catchup.test";
import { mcThreeClientRenameOfflineUpdateTest } from "./tests/mc-three-client-rename-offline-update.test";
import { mcMultiDeleteOfflineRenameTest } from "./tests/mc-multi-delete-offline-rename.test";
import { mcCrossCreateRenameSameTargetTest } from "./tests/mc-cross-create-rename-same-target.test";
import { mcDeleteThenOfflineRenameTest } from "./tests/mc-delete-then-offline-rename.test";
import { offlineMixedOperationsTest } from "./tests/offline-mixed-operations.test";
import { offlineCreateRenameCreateTest } from "./tests/offline-create-rename-create.test";
import { offlineConcurrentRenamesTest } from "./tests/offline-concurrent-renames.test";
import { offlineMultipleEditsTest } from "./tests/offline-multiple-edits.test";
import { serverPauseBothClientsCreateTest } from "./tests/server-pause-both-clients-create.test";
import { serverPauseRenameTest } from "./tests/server-pause-rename-propagation.test";
import { serverPauseConcurrentCreatesTest } from "./tests/server-pause-concurrent-creates.test";
import { serverPauseUpdateAndCreateTest } from "./tests/server-pause-update-and-create.test";
import { renameSwapTest } from "./tests/rename-swap.test";
import { renameCircularTest } from "./tests/rename-circular.test";
import { renameNestedPathTest } from "./tests/rename-nested-path.test";
import { renameRoundtripTest } from "./tests/rename-roundtrip.test";
import { offlineRenameRemoteCreateOldPathTest } from "./tests/offline-rename-remote-create-old-path.test";
import { offlineEditRemoteRenameTest } from "./tests/offline-edit-remote-rename.test";
import { renameChainThenDeleteTest } from "./tests/rename-chain-then-delete.test";
import { offlineDeleteRemoteRenameTest } from "./tests/offline-delete-remote-rename.test";
import { renameToRecentlyDeletedPathTest } from "./tests/rename-to-recently-deleted-path.test";
import { createUpdateCoalesceServerPauseTest } from "./tests/create-update-coalesce-server-pause.test";
import { overlappingEditsSameSectionTest } from "./tests/overlapping-edits-same-section.test";
import { rapidUpdatesAfterMergeTest } from "./tests/rapid-updates-after-merge.test";
import { offlineRenamePendingCreateTest } from "./tests/offline-rename-pending-create.test";
import { deleteRecreateConcurrentUpdateTest } from "./tests/delete-recreate-concurrent-update.test";
import { moveAndConcurrentRemoteUpdateTest } from "./tests/move-and-concurrent-remote-update.test";
import { offlineDeleteVsRemoteUpdateTest } from "./tests/offline-delete-vs-remote-update.test";
import { doubleOfflineCycleTest } from "./tests/double-offline-cycle.test";
import { createRenameCreateSamePathTest } from "./tests/create-rename-create-same-path.test";
import { concurrentEditExactSamePositionTest } from "./tests/concurrent-edit-exact-same-position.test";
import { serverPauseRenameEditResumeTest } from "./tests/server-pause-rename-edit-resume.test";
import { renameTrackedToOccupiedPendingPathTest } from "./tests/rename-tracked-to-occupied-pending-path.test";
import { offlineUpdateBothThenDeleteOneTest } from "./tests/offline-update-both-then-delete-one.test";
import { moveIdenticalContentAmbiguityTest } from "./tests/move-identical-content-ambiguity.test";
import { coalesceUpdateRemoteUpdateDataLossTest } from "./tests/coalesce-update-remote-update-data-loss.test";
import { offlineCreateSamePathMergeableTest } from "./tests/offline-create-same-path-binary-conflict.test";
import { deleteDuringPendingCreateTest } from "./tests/delete-during-pending-create.test";
import { threeClientRenameCreateDeleteTest } from "./tests/three-client-rename-create-delete.test";
import { keyMigrationEventDropTest } from "./tests/key-migration-event-drop.test";
import { renameToPathOfUnconfirmedDeleteTest } from "./tests/rename-to-path-of-unconfirmed-delete.test";
import { offlineEditThenMoveSameContentTest } from "./tests/offline-edit-then-move-same-content.test";
import { concurrentRenameAndCreateAtTargetTest } from "./tests/concurrent-rename-and-create-at-target.test";
import { createRenameCreateSamePathOfflineTest } from "./tests/create-rename-create-same-path-offline.test";
import { rapidCreateUpdateDeleteCycleTest } from "./tests/rapid-create-update-delete-cycle.test";
import { serverPauseBothEditSameFileTest } from "./tests/server-pause-both-edit-same-file.test";
import { reconcilePendingAtOccupiedPathTest } from "./tests/reconcile-pending-at-occupied-path.test";
import { offlineRenameBothClientsSameSourceTest } from "./tests/offline-rename-both-clients-same-source.test";
import { createDuringReconciliationTest } from "./tests/create-during-reconciliation.test";
import { deleteRecreateDifferentContentTest } from "./tests/delete-recreate-different-content.test";
import { moveChainThreeFilesTest } from "./tests/move-chain-three-files.test";
import { updateDuringCreateProcessingTest } from "./tests/update-during-create-processing.test";
import { offlineMoveThenRemoteDeleteTest } from "./tests/offline-move-then-remote-delete.test";
import { resetClearsRecentlyDeletedResurrectionTest } from "./tests/reset-clears-recently-deleted-resurrection.test";
import { moveThenDeleteStalePathTest } from "./tests/move-then-delete-stale-path.test";
import { interruptedDeleteRetryTest } from "./tests/interrupted-delete-retry.test";
import { updateSurvivesRemoteDeleteTest } from "./tests/update-survives-remote-delete.test";
import { movePreservesRemoteUpdateTest } from "./tests/move-preserves-remote-update.test";
import { recentlyDeletedClearedOnReconnectTest } from "./tests/recently-deleted-cleared-on-reconnect.test";
import { migrateKeyPreservesExistingTest } from "./tests/migrate-key-preserves-existing.test";
import { userParenthesizedFileNotDeletedTest } from "./tests/user-parenthesized-file-not-deleted.test";
import { concurrentUpdateDiffConsistencyTest } from "./tests/concurrent-update-diff-consistency.test";
import { concurrentDeleteDuringRemoteUpdateTest } from "./tests/concurrent-delete-during-remote-update.test";
import { binaryPendingCreateNotDisplacedTest } from "./tests/binary-pending-create-not-displaced.test";
import { failedVfsMoveFallsBackTest } from "./tests/failed-vfs-move-falls-back.test";
import { watermarkAdvancesOnSkipTest } from "./tests/watermark-advances-on-skip.test";
import { remoteDeleteCoalesceLosesLocalUpdateTest } from "./tests/remote-delete-coalesce-loses-local-update.test";
import { updateVsRemoteDeleteDataLossTest } from "./tests/update-vs-remote-delete-data-loss.test";
import { watermarkGapRemoteUpdateNotRecordedTest } from "./tests/watermark-gap-remote-update-not-recorded.test";
import { renameEmptyFileLosesIdentityTest } from "./tests/rename-empty-file-loses-identity.test";
import { queueResetLosesCoalescedLocalEditTest } from "./tests/queue-reset-loses-coalesced-local-edit.test";
import { renameToPendingPathFallbackTest } from "./tests/rename-to-pending-path-fallback.test";
import { coalescedRemoteUpdateWatermarkLossTest } from "./tests/coalesced-remote-update-watermark-loss.test";
import { moveRemoteUpdateRevertsRenameTest } from "./tests/move-remote-update-reverts-rename.test";
import { createMergePreservesRenamedUpdateTest } from "./tests/create-merge-preserves-renamed-update.test";
import { localEditLostDuringCreateMergeTest } from "./tests/local-edit-lost-during-create-merge.test";
import { concurrentBinaryCreateDeconflictionTest } from "./tests/concurrent-binary-create-deconfliction.test";
import { renamePendingCreateBeforeResponseTest } from "./tests/rename-pending-create-before-response.test";
import { createRenameResponseSkipsFileTest } from "./tests/create-rename-response-skips-file.test";
import { staleDocOrphanDuplicateContentTest } from "./tests/stale-doc-orphan-duplicate-content.test";

export const TESTS: Partial<Record<string, TestDefinition>> = {
    "write-write-conflict": writeWriteConflictTest,
    "rename-create-conflict": renameCreateConflictTest,
    "create-delete-noop": createDeleteNoopTest,
    "rename-chain": renameChainTest,
    "server-pause-resume": serverPauseResumeTest,
    "create-merge-delete": createMergeDeleteTest,
    "rename-update-conflict": renameUpdateConflictTest,
    "delete-rename-conflict": deleteRenameConflictTest,
    "multi-file-operations": multiFileOperationsTest,
    "duplicate-content-files": duplicateContentFilesTest,
    "delete-recreate-same-path": deleteRecreateSamePathTest,
    "rapid-sync-toggle": rapidSyncToggleTest,
    "concurrent-delete-update": concurrentDeleteUpdateTest,
    "offline-rename-and-edit": offlineRenameAndEditTest,
    "three-client-convergence": threeClientConvergenceTest,
    "update-during-server-pause": updateDuringServerPauseTest,
    "empty-file-sync": emptyFileSyncTest,
    "rename-to-existing-path": renameToExistingPathTest,
    "concurrent-rename-same-target": concurrentRenameSameTargetTest,
    "multiple-updates-coalesce": multipleUpdatesCoalesceTest,
    "delete-nonexistent-file": deleteNonexistentFileTest,
    "create-while-server-paused": createWhileServerPausedTest,
    "interleaved-operations": interleavedOperationsTest,
    "simultaneous-create-delete-same-path": simultaneousCreateDeleteSamePathTest,
    "large-file-count": largeFileCountTest,
    "offline-operations-both-clients": offlineOperationsBothClientsTest,
    "update-then-rename": updateThenRenameTest,
    "idempotency-after-server-pause": idempotencyAfterServerPauseTest,
    "concurrent-create-same-path-merge": concurrentCreateSamePathMergeTest,
    "sequential-create-duplicate-content": sequentialCreateDuplicateContentTest,
    "offline-multi-update-catchup": offlineMultiUpdateCatchupTest,
    "mc-three-client-rename-offline-update": mcThreeClientRenameOfflineUpdateTest,
    "mc-multi-delete-offline-rename": mcMultiDeleteOfflineRenameTest,
    "mc-cross-create-rename-same-target": mcCrossCreateRenameSameTargetTest,
    "mc-delete-then-offline-rename": mcDeleteThenOfflineRenameTest,
    "offline-mixed-operations": offlineMixedOperationsTest,
    "offline-create-rename-create": offlineCreateRenameCreateTest,
    "offline-concurrent-renames": offlineConcurrentRenamesTest,
    "offline-multiple-edits": offlineMultipleEditsTest,
    "server-pause-both-clients-create": serverPauseBothClientsCreateTest,
    "server-pause-rename-propagation": serverPauseRenameTest,
    "server-pause-concurrent-creates": serverPauseConcurrentCreatesTest,
    "server-pause-update-and-create": serverPauseUpdateAndCreateTest,
    "rename-swap": renameSwapTest,
    "rename-circular": renameCircularTest,
    "rename-nested-path": renameNestedPathTest,
    "rename-roundtrip": renameRoundtripTest,
    "offline-rename-remote-create-old-path": offlineRenameRemoteCreateOldPathTest,
    "offline-edit-remote-rename": offlineEditRemoteRenameTest,
    "rename-chain-then-delete": renameChainThenDeleteTest,
    "offline-delete-remote-rename": offlineDeleteRemoteRenameTest,
    "rename-to-recently-deleted-path": renameToRecentlyDeletedPathTest,
    "create-update-coalesce-server-pause": createUpdateCoalesceServerPauseTest,
    "overlapping-edits-same-section": overlappingEditsSameSectionTest,
    "rapid-updates-after-merge": rapidUpdatesAfterMergeTest,
    "offline-rename-pending-create": offlineRenamePendingCreateTest,
    "delete-recreate-concurrent-update": deleteRecreateConcurrentUpdateTest,
    "move-and-concurrent-remote-update": moveAndConcurrentRemoteUpdateTest,
    "double-offline-cycle": doubleOfflineCycleTest,
    "create-rename-create-same-path": createRenameCreateSamePathTest,
    "concurrent-edit-exact-same-position": concurrentEditExactSamePositionTest,
    "server-pause-rename-edit-resume": serverPauseRenameEditResumeTest,
    "rename-tracked-to-occupied-pending-path": renameTrackedToOccupiedPendingPathTest,
    "offline-update-both-then-delete-one": offlineUpdateBothThenDeleteOneTest,
    "move-identical-content-ambiguity": moveIdenticalContentAmbiguityTest,
    "coalesce-update-remote-update-data-loss": coalesceUpdateRemoteUpdateDataLossTest,
    "offline-create-same-path-mergeable": offlineCreateSamePathMergeableTest,
    "delete-during-pending-create": deleteDuringPendingCreateTest,
    "three-client-rename-create-delete": threeClientRenameCreateDeleteTest,
    "key-migration-event-drop": keyMigrationEventDropTest,
    "rename-to-path-of-unconfirmed-delete": renameToPathOfUnconfirmedDeleteTest,
    "offline-edit-then-move-same-content": offlineEditThenMoveSameContentTest,
    "concurrent-rename-and-create-at-target": concurrentRenameAndCreateAtTargetTest,
    "create-rename-create-same-path-offline": createRenameCreateSamePathOfflineTest,
    "rapid-create-update-delete-cycle": rapidCreateUpdateDeleteCycleTest,
    "server-pause-both-edit-same-file": serverPauseBothEditSameFileTest,
    "reconcile-pending-at-occupied-path": reconcilePendingAtOccupiedPathTest,
    "offline-rename-both-clients-same-source": offlineRenameBothClientsSameSourceTest,
    "create-during-reconciliation": createDuringReconciliationTest,
    "delete-recreate-different-content": deleteRecreateDifferentContentTest,
    "move-chain-three-files": moveChainThreeFilesTest,
    "update-during-create-processing": updateDuringCreateProcessingTest,
    "offline-move-then-remote-delete": offlineMoveThenRemoteDeleteTest,
    "reset-clears-recently-deleted-resurrection": resetClearsRecentlyDeletedResurrectionTest,
    "move-then-delete-stale-path": moveThenDeleteStalePathTest,
    "offline-delete-vs-remote-update": offlineDeleteVsRemoteUpdateTest,
    "interrupted-delete-retry": interruptedDeleteRetryTest,
    "update-survives-remote-delete": updateSurvivesRemoteDeleteTest,
    "move-preserves-remote-update": movePreservesRemoteUpdateTest,
    "recently-deleted-cleared-on-reconnect": recentlyDeletedClearedOnReconnectTest,
    "migrate-key-preserves-existing": migrateKeyPreservesExistingTest,
    "user-parenthesized-file-not-deleted": userParenthesizedFileNotDeletedTest,
    "concurrent-update-diff-consistency": concurrentUpdateDiffConsistencyTest,
    "concurrent-delete-during-remote-update": concurrentDeleteDuringRemoteUpdateTest,
    "binary-pending-create-not-displaced": binaryPendingCreateNotDisplacedTest,
    "failed-vfs-move-falls-back": failedVfsMoveFallsBackTest,
    "watermark-advances-on-skip": watermarkAdvancesOnSkipTest,
    "remote-delete-coalesce-loses-local-update": remoteDeleteCoalesceLosesLocalUpdateTest,
    "update-vs-remote-delete-data-loss": updateVsRemoteDeleteDataLossTest,
    "watermark-gap-remote-update-not-recorded": watermarkGapRemoteUpdateNotRecordedTest,
    "rename-empty-file-loses-identity": renameEmptyFileLosesIdentityTest,
    "queue-reset-loses-coalesced-local-edit": queueResetLosesCoalescedLocalEditTest,
    "rename-to-pending-path-fallback": renameToPendingPathFallbackTest,
    "coalesced-remote-update-watermark-loss": coalescedRemoteUpdateWatermarkLossTest,
    "move-remote-update-reverts-rename": moveRemoteUpdateRevertsRenameTest,
    "create-merge-preserves-renamed-update": createMergePreservesRenamedUpdateTest,
    "local-edit-lost-during-create-merge": localEditLostDuringCreateMergeTest,
    "concurrent-binary-create-deconfliction": concurrentBinaryCreateDeconflictionTest,
    "rename-pending-create-before-response": renamePendingCreateBeforeResponseTest,
    "create-rename-response-skips-file": createRenameResponseSkipsFileTest,
    "stale-doc-orphan-duplicate-content": staleDocOrphanDuplicateContentTest
};
