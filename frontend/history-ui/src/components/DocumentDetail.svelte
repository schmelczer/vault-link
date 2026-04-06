<script lang="ts">
    import {
        auth,
        toasts,
        relativeTime,
        absoluteTime,
        formatBytes,
        inferAction,
        isTextFile,
        isImageFile,
        fileExtension
    } from "../lib/stores.svelte";
    import type {
        DocumentVersionWithoutContent,
        DocumentVersion,
        ActionType
    } from "../lib/types";
    import DiffView from "./DiffView.svelte";
    import ConfirmDialog from "./ConfirmDialog.svelte";

    interface Props {
        documentId: string;
        onClose: () => void;
        onRestore: () => void;
    }

    let { documentId, onClose, onRestore }: Props = $props();

    let versions = $state<DocumentVersionWithoutContent[]>([]);
    let loading = $state(true);
    let selectedVersion = $state<DocumentVersionWithoutContent | null>(null);
    let loadedContent = $state<string | null>(null);
    let loadedContentBytes = $state<ArrayBuffer | null>(null);
    let loadingContent = $state(false);
    let activeTab = $state<"preview" | "diff">("preview");

    // Diff state
    let diffOldContent = $state<string | null>(null);
    let diffNewContent = $state<string | null>(null);
    let diffOldLabel = $state("");
    let diffNewLabel = $state("");

    // Restore state
    let showRestoreDialog = $state(false);
    let restoreTarget = $state<DocumentVersionWithoutContent | null>(null);
    let restoring = $state(false);

    let latest = $derived(versions.at(-1) ?? null);
    let isDeleted = $derived(latest?.isDeleted ?? false);
    let currentPath = $derived(latest?.relativePath ?? "");

    // Derive action types
    let versionEvents = $derived(
        versions.map((v, i) => ({
            version: v,
            action: inferAction(v, i > 0 ? versions[i - 1] : undefined) as ActionType,
            previousPath: i > 0 && versions[i - 1].relativePath !== v.relativePath
                ? versions[i - 1].relativePath
                : undefined
        }))
    );

    async function loadVersions() {
        const api = auth.api;
        if (!api) return;
        loading = true;
        try {
            versions = await api.fetchDocumentVersions(documentId);
            // Auto-select latest
            if (versions.length > 0) {
                await selectVersion(versions.at(-1)!);
            }
        } catch {
            toasts.add("Failed to load document versions", "error");
        } finally {
            loading = false;
        }
    }

    async function selectVersion(v: DocumentVersionWithoutContent) {
        selectedVersion = v;
        activeTab = "preview";
        diffOldContent = null;
        diffNewContent = null;
        loadingContent = true;
        loadedContent = null;
        loadedContentBytes = null;

        const api = auth.api;
        if (!api) return;

        try {
            if (isTextFile(v.relativePath) || fileExtension(v.relativePath) === "") {
                const fullVersion = await api.fetchDocumentVersion(
                    documentId,
                    v.vaultUpdateId
                );
                const bytes = Uint8Array.from(atob(fullVersion.contentBase64), c => c.charCodeAt(0));
                const decoder = new TextDecoder("utf-8", { fatal: false });
                loadedContent = decoder.decode(bytes);
                loadedContentBytes = bytes.buffer;
            } else if (isImageFile(v.relativePath)) {
                loadedContentBytes = await api.fetchDocumentVersionContent(
                    documentId,
                    v.vaultUpdateId
                );
            } else {
                loadedContentBytes = await api.fetchDocumentVersionContent(
                    documentId,
                    v.vaultUpdateId
                );
            }
        } catch {
            toasts.add("Failed to load content", "error");
        } finally {
            loadingContent = false;
        }
    }

    async function showDiff(v: DocumentVersionWithoutContent, idx: number) {
        const api = auth.api;
        if (!api || idx === 0) return;

        activeTab = "diff";
        loadingContent = true;

        const prev = versions[idx - 1];
        try {
            const [oldVer, newVer] = await Promise.all([
                api.fetchDocumentVersion(documentId, prev.vaultUpdateId),
                api.fetchDocumentVersion(documentId, v.vaultUpdateId)
            ]);
            const decode = (b64: string) => {
                const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
            };
            diffOldContent = decode(oldVer.contentBase64);
            diffNewContent = decode(newVer.contentBase64);
            diffOldLabel = `v${prev.vaultUpdateId}`;
            diffNewLabel = `v${v.vaultUpdateId}`;
        } catch {
            toasts.add("Failed to load diff", "error");
        } finally {
            loadingContent = false;
        }
    }

    function confirmRestore(v: DocumentVersionWithoutContent) {
        restoreTarget = v;
        showRestoreDialog = true;
    }

    async function executeRestore() {
        const api = auth.api;
        if (!api || !restoreTarget) return;
        restoring = true;
        try {
            await api.restoreVersion(
                documentId,
                restoreTarget.vaultUpdateId
            );
            toasts.add(
                `Restored to version #${restoreTarget.vaultUpdateId}`,
                "success"
            );
            showRestoreDialog = false;
            restoreTarget = null;
            onRestore();
            await loadVersions();
        } catch (e) {
            toasts.add(`Restore failed: ${e}`, "error");
        } finally {
            restoring = false;
        }
    }

    function getImageUrl(buffer: ArrayBuffer, path: string): string {
        const ext = fileExtension(path);
        const mimeMap: Record<string, string> = {
            png: "image/png",
            jpg: "image/jpeg",
            jpeg: "image/jpeg",
            gif: "image/gif",
            webp: "image/webp",
            svg: "image/svg+xml",
            ico: "image/x-icon",
            bmp: "image/bmp"
        };
        const mime = mimeMap[ext] ?? "application/octet-stream";
        const blob = new Blob([buffer], { type: mime });
        return URL.createObjectURL(blob);
    }

    $effect(() => {
        loadVersions();
    });

    const actionColors: Record<string, string> = {
        created: "var(--green)",
        updated: "var(--blue)",
        renamed: "var(--orange)",
        deleted: "var(--red)",
        restored: "var(--purple)"
    };

    const actionBgColors: Record<string, string> = {
        created: "var(--green-bg)",
        updated: "var(--blue-bg)",
        renamed: "var(--orange-bg)",
        deleted: "var(--red-bg)",
        restored: "var(--purple-bg)"
    };
</script>

<div class="detail">
    <!-- Header -->
    <div class="detail-header">
        <button class="back-btn" onclick={onClose} title="Back">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
        </button>
        <div class="header-info">
            <div class="header-path">
                <span class="path-text" class:deleted-path={isDeleted}>
                    {currentPath}
                </span>
                {#if isDeleted}
                    <span class="status-badge deleted-badge">Deleted</span>
                {:else}
                    <span class="status-badge active-badge">Active</span>
                {/if}
            </div>
            <div class="header-meta">
                <span class="doc-id" title={documentId}>
                    {documentId.substring(0, 8)}...
                </span>
                {#if latest}
                    <span>&middot;</span>
                    <span>{versions.length} version{versions.length !== 1 ? "s" : ""}</span>
                    <span>&middot;</span>
                    <span>Last by {latest.userId}</span>
                {/if}
            </div>
        </div>
    </div>

    {#if loading}
        <div class="detail-loading">Loading versions...</div>
    {:else}
        <!-- Content area -->
        <div class="detail-body">
            <div class="content-panel">
                {#if selectedVersion}
                    <div class="content-tabs">
                        <button
                            class="content-tab"
                            class:active={activeTab === "preview"}
                            onclick={() => (activeTab = "preview")}
                        >
                            Preview
                        </button>
                        <button
                            class="content-tab"
                            class:active={activeTab === "diff"}
                            onclick={() => {
                                if (selectedVersion) {
                                    const idx = versions.indexOf(selectedVersion);
                                    if (idx > 0) showDiff(selectedVersion, idx);
                                }
                            }}
                            disabled={versions.indexOf(selectedVersion) === 0}
                        >
                            Diff
                        </button>
                        <div class="content-tab-spacer"></div>
                        <span class="viewing-label">
                            Viewing v#{selectedVersion.vaultUpdateId}
                            &middot;
                            {relativeTime(selectedVersion.updatedDate)}
                        </span>
                    </div>

                    <div class="content-view">
                        {#if loadingContent}
                            <div class="content-loading">Loading content...</div>
                        {:else if activeTab === "diff" && diffOldContent !== null && diffNewContent !== null}
                            <DiffView
                                oldContent={diffOldContent}
                                newContent={diffNewContent}
                                oldLabel={diffOldLabel}
                                newLabel={diffNewLabel}
                            />
                        {:else if activeTab === "preview"}
                            {#if isTextFile(selectedVersion.relativePath) || fileExtension(selectedVersion.relativePath) === ""}
                                <pre class="text-content">{loadedContent ?? ""}</pre>
                            {:else if isImageFile(selectedVersion.relativePath) && loadedContentBytes}
                                <div class="image-preview">
                                    <img
                                        src={getImageUrl(loadedContentBytes, selectedVersion.relativePath)}
                                        alt={selectedVersion.relativePath}
                                    />
                                </div>
                            {:else}
                                <div class="binary-placeholder">
                                    <div class="binary-icon">📦</div>
                                    <div class="binary-label">Binary file</div>
                                    <div class="binary-size">
                                        {formatBytes(selectedVersion.contentSize)}
                                    </div>
                                </div>
                            {/if}
                        {/if}
                    </div>
                {/if}
            </div>

            <!-- Version timeline -->
            <div class="version-panel">
                <div class="version-panel-header">Version History</div>
                <div class="version-list">
                    {#each [...versionEvents].reverse() as event, i}
                        {@const v = event.version}
                        {@const isSelected = selectedVersion?.vaultUpdateId === v.vaultUpdateId}
                        <div class="version-item" class:selected={isSelected}>
                            <button
                                class="version-main"
                                onclick={() => selectVersion(v)}
                            >
                                <div class="version-left">
                                    <span class="version-id">#{v.vaultUpdateId}</span>
                                    <span
                                        class="version-action"
                                        style="color: {actionColors[event.action]}; background: {actionBgColors[event.action]}"
                                    >
                                        {event.action}
                                    </span>
                                </div>
                                <div class="version-right">
                                    <span class="version-user">{v.userId}</span>
                                    <span
                                        class="version-time"
                                        title={absoluteTime(v.updatedDate)}
                                    >
                                        {relativeTime(v.updatedDate)}
                                    </span>
                                    <span class="version-size">{formatBytes(v.contentSize)}</span>
                                </div>
                            </button>
                            {#if event.previousPath}
                                <div class="version-rename">
                                    {event.previousPath} &rarr; {v.relativePath}
                                </div>
                            {/if}
                            <div class="version-actions">
                                {#if i < versionEvents.length - 1}
                                    <button
                                        class="version-btn"
                                        onclick={() => {
                                            const realIdx = versions.indexOf(v);
                                            showDiff(v, realIdx);
                                        }}
                                    >
                                        Diff
                                    </button>
                                {/if}
                                {#if v !== latest}
                                    <button
                                        class="version-btn restore-btn"
                                        onclick={() => confirmRestore(v)}
                                    >
                                        Restore
                                    </button>
                                {/if}
                            </div>
                        </div>
                    {/each}
                </div>
            </div>
        </div>
    {/if}
</div>

{#if showRestoreDialog && restoreTarget}
    <ConfirmDialog
        title="Restore Version"
        message={`Restore "${currentPath}" to version #${restoreTarget.vaultUpdateId} from ${absoluteTime(restoreTarget.updatedDate)}? This creates a new version with the old content. Current content is preserved in history.`}
        confirmLabel="Restore"
        destructive={false}
        loading={restoring}
        onConfirm={executeRestore}
        onCancel={() => {
            showRestoreDialog = false;
            restoreTarget = null;
        }}
    />
{/if}

<style>
    .detail {
        display: flex;
        flex-direction: column;
        height: 100%;
        overflow: hidden;
    }

    .detail-header {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
        flex-shrink: 0;
    }

    .back-btn {
        padding: 6px;
        border-radius: var(--radius-sm);
        color: var(--text-muted);
        transition: color 0.15s, background 0.15s;
        flex-shrink: 0;
    }

    .back-btn:hover {
        color: var(--text);
        background: var(--bg-hover);
    }

    .header-info {
        flex: 1;
        min-width: 0;
    }

    .header-path {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .path-text {
        font-family: var(--mono);
        font-size: 15px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .deleted-path {
        text-decoration: line-through;
        opacity: 0.6;
    }

    .status-badge {
        font-size: 10px;
        font-weight: 600;
        padding: 1px 8px;
        border-radius: 10px;
        text-transform: uppercase;
        flex-shrink: 0;
    }

    .active-badge {
        color: var(--green);
        background: var(--green-bg);
    }

    .deleted-badge {
        color: var(--red);
        background: var(--red-bg);
    }

    .header-meta {
        font-size: 12px;
        color: var(--text-muted);
        margin-top: 2px;
        display: flex;
        gap: 6px;
    }

    .doc-id {
        font-family: var(--mono);
        cursor: help;
    }

    .detail-loading {
        padding: 48px;
        text-align: center;
        color: var(--text-muted);
    }

    .detail-body {
        display: flex;
        flex: 1;
        overflow: hidden;
    }

    .content-panel {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .content-tabs {
        display: flex;
        align-items: center;
        padding: 0 16px;
        border-bottom: 1px solid var(--border);
        background: var(--bg);
        flex-shrink: 0;
    }

    .content-tab {
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-muted);
        border-bottom: 2px solid transparent;
        transition: color 0.15s, border-color 0.15s;
    }

    .content-tab:hover:not(:disabled) {
        color: var(--text);
    }

    .content-tab.active {
        color: var(--text);
        border-bottom-color: var(--accent);
    }

    .content-tab:disabled {
        opacity: 0.3;
        cursor: not-allowed;
    }

    .content-tab-spacer {
        flex: 1;
    }

    .viewing-label {
        font-size: 12px;
        color: var(--text-subtle);
        font-family: var(--mono);
    }

    .content-view {
        flex: 1;
        overflow: auto;
    }

    .content-loading {
        padding: 48px;
        text-align: center;
        color: var(--text-muted);
    }

    .text-content {
        padding: 16px;
        font-family: var(--mono);
        font-size: 13px;
        line-height: 1.6;
        white-space: pre-wrap;
        word-break: break-word;
        tab-size: 4;
    }

    .image-preview {
        padding: 16px;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .image-preview img {
        max-width: 100%;
        max-height: 60vh;
        border-radius: var(--radius);
        border: 1px solid var(--border);
    }

    .binary-placeholder {
        padding: 64px;
        text-align: center;
        color: var(--text-muted);
    }

    .binary-icon {
        font-size: 48px;
        margin-bottom: 12px;
    }

    .binary-label {
        font-size: 16px;
        font-weight: 500;
    }

    .binary-size {
        font-size: 14px;
        margin-top: 4px;
    }

    /* Version panel */
    .version-panel {
        width: 320px;
        min-width: 320px;
        border-left: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: var(--bg-secondary);
    }

    .version-panel-header {
        padding: 10px 16px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
    }

    .version-list {
        flex: 1;
        overflow-y: auto;
    }

    .version-item {
        border-bottom: 1px solid var(--border-light);
        padding: 8px 12px;
        transition: background 0.1s;
    }

    .version-item:hover {
        background: var(--bg-hover);
    }

    .version-item.selected {
        background: var(--blue-bg);
    }

    .version-main {
        width: 100%;
        text-align: left;
    }

    .version-left {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 4px;
    }

    .version-id {
        font-family: var(--mono);
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
    }

    .version-action {
        font-size: 10px;
        font-weight: 600;
        padding: 0 6px;
        border-radius: 8px;
        text-transform: uppercase;
    }

    .version-right {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 11px;
        color: var(--text-muted);
    }

    .version-rename {
        font-size: 11px;
        color: var(--orange);
        font-family: var(--mono);
        margin: 4px 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .version-actions {
        display: flex;
        gap: 8px;
        margin-top: 6px;
    }

    .version-btn {
        font-size: 11px;
        color: var(--accent);
        padding: 2px 8px;
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        transition: background 0.15s;
    }

    .version-btn:hover {
        background: var(--bg-hover);
    }

    .restore-btn {
        color: var(--orange);
    }
</style>
