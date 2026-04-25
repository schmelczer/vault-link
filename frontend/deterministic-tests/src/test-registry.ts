import type { TestDefinition } from "./test-definition";
import { renameCreateConflictTest } from "./tests/rename-create-conflict.test";
import { renameChainTest } from "./tests/rename-chain.test";
import { renameUpdateConflictTest } from "./tests/rename-update-conflict.test";
import { deleteRenameConflictTest } from "./tests/delete-rename-conflict.test";
import { multiFileOperationsTest } from "./tests/multi-file-operations.test";
import { deleteRecreateSamePathTest } from "./tests/delete-recreate-same-path.test";
import { offlineRenameAndEditTest } from "./tests/offline-rename-and-edit.test";
import { renameToExistingPathTest } from "./tests/rename-to-existing-path.test";
import { simultaneousCreateDeleteSamePathTest } from "./tests/simultaneous-create-delete-same-path.test";
import { idempotencyAfterServerPauseTest } from "./tests/idempotency-after-server-pause.test";
import { sequentialCreateDuplicateContentTest } from "./tests/sequential-create-duplicate-content.test";
import { mcThreeClientRenameOfflineUpdateTest } from "./tests/mc-three-client-rename-offline-update.test";
import { mcMultiDeleteOfflineRenameTest } from "./tests/mc-multi-delete-offline-rename.test";
import { mcCrossCreateRenameSameTargetTest } from "./tests/mc-cross-create-rename-same-target.test";
import { mcDeleteThenOfflineRenameTest } from "./tests/mc-delete-then-offline-rename.test";
import { offlineMixedOperationsTest } from "./tests/offline-mixed-operations.test";
import { offlineConcurrentRenamesTest } from "./tests/offline-concurrent-renames.test";
import { offlineMultipleEditsTest } from "./tests/offline-multiple-edits.test";
import { serverPauseBothClientsCreateTest } from "./tests/server-pause-both-clients-create.test";
import { serverPauseUpdateAndCreateTest } from "./tests/server-pause-update-and-create.test";
import { renameSwapTest } from "./tests/rename-swap.test";
import { renameCircularTest } from "./tests/rename-circular.test";
import { renameRoundtripTest } from "./tests/rename-roundtrip.test";
import { offlineRenameRemoteCreateOldPathTest } from "./tests/offline-rename-remote-create-old-path.test";
import { offlineEditRemoteRenameTest } from "./tests/offline-edit-remote-rename.test";
import { renameChainThenDeleteTest } from "./tests/rename-chain-then-delete.test";
import { offlineDeleteRemoteRenameTest } from "./tests/offline-delete-remote-rename.test";
import { renameToRecentlyDeletedPathTest } from "./tests/rename-to-recently-deleted-path.test";
import { overlappingEditsSameSectionTest } from "./tests/overlapping-edits-same-section.test";
import { rapidUpdatesAfterMergeTest } from "./tests/rapid-updates-after-merge.test";
import { deleteRecreateConcurrentUpdateTest } from "./tests/delete-recreate-concurrent-update.test";
import { moveAndConcurrentRemoteUpdateTest } from "./tests/move-and-concurrent-remote-update.test";
import { offlineDeleteVsRemoteUpdateTest } from "./tests/offline-delete-vs-remote-update.test";
import { doubleOfflineCycleTest } from "./tests/double-offline-cycle.test";
import { serverPauseRenameEditResumeTest } from "./tests/server-pause-rename-edit-resume.test";
import { offlineUpdateBothThenDeleteOneTest } from "./tests/offline-update-both-then-delete-one.test";
import { offlineCreateSamePathMergeableTest } from "./tests/offline-create-same-path-binary-conflict.test";
import { deleteDuringPendingCreateTest } from "./tests/delete-during-pending-create.test";
import { threeClientRenameCreateDeleteTest } from "./tests/three-client-rename-create-delete.test";
import { keyMigrationEventDropTest } from "./tests/key-migration-event-drop.test";
import { renameToPathOfUnconfirmedDeleteTest } from "./tests/rename-to-path-of-unconfirmed-delete.test";
import { offlineEditThenMoveSameContentTest } from "./tests/offline-edit-then-move-same-content.test";
import { rapidCreateUpdateDeleteCycleTest } from "./tests/rapid-create-update-delete-cycle.test";
import { serverPauseBothEditSameFileTest } from "./tests/server-pause-both-edit-same-file.test";
import { deleteRecreateDifferentContentTest } from "./tests/delete-recreate-different-content.test";
import { updateDuringCreateProcessingTest } from "./tests/update-during-create-processing.test";
import { offlineMoveThenRemoteDeleteTest } from "./tests/offline-move-then-remote-delete.test";
import { resetClearsRecentlyDeletedResurrectionTest } from "./tests/reset-clears-recently-deleted-resurrection.test";
import { moveThenDeleteStalePathTest } from "./tests/move-then-delete-stale-path.test";
import { interruptedDeleteRetryTest } from "./tests/interrupted-delete-retry.test";
import { updateDoesNotSurvivesRemoteDeleteTest } from "./tests/update-survives-remote-delete.test";
import { movePreservesRemoteUpdateTest } from "./tests/move-preserves-remote-update.test";
import { recentlyDeletedClearedOnReconnectTest } from "./tests/recently-deleted-cleared-on-reconnect.test";
import { migrateKeyPreservesExistingTest } from "./tests/migrate-key-preserves-existing.test";
import { failedVfsMoveFallsBackTest } from "./tests/failed-vfs-move-falls-back.test";
import { watermarkAdvancesOnSkipTest } from "./tests/watermark-advances-on-skip.test";
import { watermarkGapRemoteUpdateNotRecordedTest } from "./tests/watermark-gap-remote-update-not-recorded.test";
import { queueResetLosesCoalescedLocalEditTest } from "./tests/queue-reset-loses-coalesced-local-edit.test";
import { renameToPendingPathFallbackTest } from "./tests/rename-to-pending-path-fallback.test";
import { moveRemoteUpdateRevertsRenameTest } from "./tests/move-remote-update-reverts-rename.test";
import { localEditLostDuringCreateMergeTest } from "./tests/local-edit-lost-during-create-merge.test";
import { renamePendingCreateBeforeResponseTest } from "./tests/rename-pending-create-before-response.test";
import { createRenameResponseSkipsFileTest } from "./tests/create-rename-response-skips-file.test";
import { onlineCreateRenameConcurrentCreateOrphanTest } from "./tests/online-create-rename-concurrent-create-orphan.test";
import { concurrentRenameFirstWinsTest } from "./tests/concurrent-rename-first-wins.test";
import { binaryToTextTransitionTest } from "./tests/binary-to-text-transition.test";
import { textPendingCreateNotDisplacedTest } from "./tests/1-text-pending-create-not-displaced.test";
import { binaryPendingCreateNotDisplacedTest } from "./tests/2-binary-pending-create-not-displaced.test";
import { coalesceUpdateRemoteUpdateDataLossTest } from "./tests/3-coalesce-update-remote-update-data-loss.test";
import { coalescedRemoteUpdateWatermarkLossTest } from "./tests/4-coalesced-remote-update-watermark-loss.test";
import { concurrentDeleteDuringRemoteUpdateTest } from "./tests/5-concurrent-delete-during-remote-update.test";
import { concurrentEditExactSamePositionTest } from "./tests/6-concurrent-edit-exact-same-position.test";
import { concurrentRenameAndCreateAtTargetTest as concurrentRenameAndCreateAtTargetRenameFirstTest } from "./tests/7-concurrent-rename-and-create-at-target.test";
import { concurrentRenameAndCreateAtTargetTest as concurrentRenameAndCreateAtTargetCreateFirstTest } from "./tests/8-concurrent-rename-and-create-at-target.test";
import { concurrentRenameSameTargetTest } from "./tests/9-concurrent-rename-same-target.test";
import { concurrentUpdateDiffConsistencyTest } from "./tests/10-concurrent-update-diff-consistency.test";
import { userParenthesizedFileNotDeletedTest } from "./tests/10-user-parenthesized-file-not-deleted.test";
import { createDeleteNoopTest } from "./tests/11-create-delete-noop.test";
import { createMergeDeleteTest } from "./tests/12-create-merge-delete.test";
import { moveIdenticalContentAmbiguityTest } from "./tests/13-move-identical-content-ambiguity.test";
import { createUpdateCoalesceServerPauseTest } from "./tests/15-create-update-coalesce-server-pause.test";
import { createDuringReconciliationTest } from "./tests/16-create-during-reconciliation.test";
import { createMergePreservesRenamedUpdateTest } from "./tests/17-create-merge-preserves-renamed-update.test";
import { createRenameCreateSamePathTest } from "./tests/18-create-rename-create-same-path.test";
import { moveChainThreeFilesTest } from "./tests/19-move-chain-three-files.test";
import { deleteByOtherClientThenRecreateTest } from "./tests/delete-by-other-client-then-recreate.test";
import { onlineDeleteRecreateRapidCycleTest } from "./tests/online-delete-recreate-rapid-cycle.test";
import { onlineEditVsDeleteConvergenceTest } from "./tests/online-edit-vs-delete-convergence.test";
import { rapidEditDeleteOnlineConvergenceTest } from "./tests/rapid-edit-delete-online-convergence.test";
import { serverPauseDeleteRecreateTest } from "./tests/server-pause-delete-recreate.test";
import { onlineBothCreateSamePathDeconflictTest } from "./tests/online-both-create-same-path-deconflict.test";
import { onlineCreateUpdateWhileOtherCreatesSamePathTest } from "./tests/online-create-update-while-other-creates-same-path.test";
import { displacedFileNotMarkedDeletedTest } from "./tests/displaced-file-not-marked-deleted.test";

export const TESTS: Partial<Record<string, TestDefinition>> = {
    "rename-create-conflict": renameCreateConflictTest,
    "rename-chain": renameChainTest,
    "rename-update-conflict": renameUpdateConflictTest,
    "delete-rename-conflict": deleteRenameConflictTest,
    "multi-file-operations": multiFileOperationsTest,
    "delete-recreate-same-path": deleteRecreateSamePathTest,
    "offline-rename-and-edit": offlineRenameAndEditTest,
    "rename-to-existing-path": renameToExistingPathTest,
    "simultaneous-create-delete-same-path":
        simultaneousCreateDeleteSamePathTest,
    "idempotency-after-server-pause": idempotencyAfterServerPauseTest,
    "sequential-create-duplicate-content": sequentialCreateDuplicateContentTest,
    "mc-three-client-rename-offline-update":
        mcThreeClientRenameOfflineUpdateTest,
    "mc-multi-delete-offline-rename": mcMultiDeleteOfflineRenameTest,
    "mc-cross-create-rename-same-target": mcCrossCreateRenameSameTargetTest,
    "mc-delete-then-offline-rename": mcDeleteThenOfflineRenameTest,
    "offline-mixed-operations": offlineMixedOperationsTest,
    "offline-concurrent-renames": offlineConcurrentRenamesTest,
    "offline-multiple-edits": offlineMultipleEditsTest,
    "server-pause-both-clients-create": serverPauseBothClientsCreateTest,
    "server-pause-update-and-create": serverPauseUpdateAndCreateTest,
    "rename-swap": renameSwapTest,
    "rename-circular": renameCircularTest,
    "rename-roundtrip": renameRoundtripTest,
    "offline-rename-remote-create-old-path":
        offlineRenameRemoteCreateOldPathTest,
    "offline-edit-remote-rename": offlineEditRemoteRenameTest,
    "rename-chain-then-delete": renameChainThenDeleteTest,
    "offline-delete-remote-rename": offlineDeleteRemoteRenameTest,
    "rename-to-recently-deleted-path": renameToRecentlyDeletedPathTest,
    "overlapping-edits-same-section": overlappingEditsSameSectionTest,
    "rapid-updates-after-merge": rapidUpdatesAfterMergeTest,
    "delete-recreate-concurrent-update": deleteRecreateConcurrentUpdateTest,
    "move-and-concurrent-remote-update": moveAndConcurrentRemoteUpdateTest,
    "double-offline-cycle": doubleOfflineCycleTest,
    "server-pause-rename-edit-resume": serverPauseRenameEditResumeTest,
    "offline-update-both-then-delete-one": offlineUpdateBothThenDeleteOneTest,
    "offline-create-same-path-mergeable": offlineCreateSamePathMergeableTest,
    "delete-during-pending-create": deleteDuringPendingCreateTest,
    "three-client-rename-create-delete": threeClientRenameCreateDeleteTest,
    "key-migration-event-drop": keyMigrationEventDropTest,
    "rename-to-path-of-unconfirmed-delete": renameToPathOfUnconfirmedDeleteTest,
    "offline-edit-then-move-same-content": offlineEditThenMoveSameContentTest,
    "rapid-create-update-delete-cycle": rapidCreateUpdateDeleteCycleTest,
    "server-pause-both-edit-same-file": serverPauseBothEditSameFileTest,
    "delete-recreate-different-content": deleteRecreateDifferentContentTest,
    "update-during-create-processing": updateDuringCreateProcessingTest,
    "offline-move-then-remote-delete": offlineMoveThenRemoteDeleteTest,
    "reset-clears-recently-deleted-resurrection":
        resetClearsRecentlyDeletedResurrectionTest,
    "move-then-delete-stale-path": moveThenDeleteStalePathTest,
    "offline-delete-vs-remote-update": offlineDeleteVsRemoteUpdateTest,
    "interrupted-delete-retry": interruptedDeleteRetryTest,
    "update-survives-remote-delete": updateDoesNotSurvivesRemoteDeleteTest,
    "move-preserves-remote-update": movePreservesRemoteUpdateTest,
    "recently-deleted-cleared-on-reconnect":
        recentlyDeletedClearedOnReconnectTest,
    "migrate-key-preserves-existing": migrateKeyPreservesExistingTest,
    "failed-vfs-move-falls-back": failedVfsMoveFallsBackTest,
    "watermark-advances-on-skip": watermarkAdvancesOnSkipTest,
    "watermark-gap-remote-update-not-recorded":
        watermarkGapRemoteUpdateNotRecordedTest,
    "queue-reset-loses-coalesced-local-edit":
        queueResetLosesCoalescedLocalEditTest,
    "rename-to-pending-path-fallback": renameToPendingPathFallbackTest,
    "move-remote-update-reverts-rename": moveRemoteUpdateRevertsRenameTest,
    "local-edit-lost-during-create-merge": localEditLostDuringCreateMergeTest,
    "rename-pending-create-before-response":
        renamePendingCreateBeforeResponseTest,
    "create-rename-response-skips-file": createRenameResponseSkipsFileTest,
    "online-create-rename-concurrent-create-orphan":
        onlineCreateRenameConcurrentCreateOrphanTest,
    "concurrent-rename-first-wins": concurrentRenameFirstWinsTest,
    "binary-to-text-transition": binaryToTextTransitionTest,
    "text-pending-create-not-displaced": textPendingCreateNotDisplacedTest,
    "binary-pending-create-not-displaced": binaryPendingCreateNotDisplacedTest,
    "coalesce-update-remote-update-data-loss":
        coalesceUpdateRemoteUpdateDataLossTest,
    "coalesced-remote-update-watermark-loss":
        coalescedRemoteUpdateWatermarkLossTest,
    "concurrent-delete-during-remote-update":
        concurrentDeleteDuringRemoteUpdateTest,
    "concurrent-edit-exact-same-position": concurrentEditExactSamePositionTest,
    "concurrent-rename-and-create-at-target-rename-first":
        concurrentRenameAndCreateAtTargetRenameFirstTest,
    "concurrent-rename-and-create-at-target-create-first":
        concurrentRenameAndCreateAtTargetCreateFirstTest,
    "concurrent-rename-same-target": concurrentRenameSameTargetTest,
    "concurrent-update-diff-consistency": concurrentUpdateDiffConsistencyTest,
    "user-parenthesized-file-not-deleted": userParenthesizedFileNotDeletedTest,
    "create-delete-noop": createDeleteNoopTest,
    "create-merge-delete": createMergeDeleteTest,
    "move-identical-content-ambiguity": moveIdenticalContentAmbiguityTest,
    "create-update-coalesce-server-pause": createUpdateCoalesceServerPauseTest,
    "create-during-reconciliation": createDuringReconciliationTest,
    "create-merge-preserves-renamed-update":
        createMergePreservesRenamedUpdateTest,
    "create-rename-create-same-path": createRenameCreateSamePathTest,
    "move-chain-three-files": moveChainThreeFilesTest,
    "delete-by-other-client-then-recreate": deleteByOtherClientThenRecreateTest,
    "online-delete-recreate-rapid-cycle": onlineDeleteRecreateRapidCycleTest,
    "online-edit-vs-delete-convergence": onlineEditVsDeleteConvergenceTest,
    "rapid-edit-delete-online-convergence":
        rapidEditDeleteOnlineConvergenceTest,
    "server-pause-delete-recreate": serverPauseDeleteRecreateTest,
    "online-both-create-same-path-deconflict":
        onlineBothCreateSamePathDeconflictTest,
    "online-create-update-while-other-creates-same-path":
        onlineCreateUpdateWhileOtherCreatesSamePathTest,
    "displaced-file-not-marked-deleted": displacedFileNotMarkedDeletedTest
};
