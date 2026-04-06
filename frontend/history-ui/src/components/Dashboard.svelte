<script lang="ts">
    import {
        auth,
        nav,
        toasts,
        buildTree,
        enrichVersions,
        relativeTime,
        formatBytes,
        type View
    } from "../lib/stores.svelte";
    import type {
        DocumentVersionWithoutContent,
        VaultHistoryResponse,
        VersionEvent,
        TreeNode
    } from "../lib/types";
    import FileTree from "./FileTree.svelte";
    import ActivityFeed from "./ActivityFeed.svelte";
    import DocumentDetail from "./DocumentDetail.svelte";
    import TimeSlider from "./TimeSlider.svelte";
    import Header from "./Header.svelte";

    interface Props {
        selectedDocumentId?: string;
    }

    let { selectedDocumentId }: Props = $props();

    // Data
    let latestDocuments = $state<DocumentVersionWithoutContent[]>([]);
    let historyVersions = $state<DocumentVersionWithoutContent[]>([]);
    let historyHasMore = $state(false);
    let loadingDocs = $state(true);
    let loadingHistory = $state(true);
    let showDeleted = $state(false);
    let searchQuery = $state("");
    let activeTab = $state<"activity" | "files">("activity");

    // Time travel
    let maxUpdateId = $state(0);
    let minUpdateId = $state(0);
    let timeSliderValue = $state<number | null>(null);

    // Derived
    let tree = $derived(buildTree(latestDocuments, showDeleted));
    let enrichedHistory = $derived(enrichVersions(historyVersions));
    let stats = $derived({
        totalDocs: latestDocuments.filter((d) => !d.isDeleted).length,
        deletedDocs: latestDocuments.filter((d) => d.isDeleted).length,
        totalSize: latestDocuments
            .filter((d) => !d.isDeleted)
            .reduce((sum, d) => sum + d.contentSize, 0),
        users: [...new Set(latestDocuments.map((d) => d.userId))]
    });

    let filteredTree = $derived.by(() => {
        if (!searchQuery) return tree;
        return filterTree(tree, searchQuery.toLowerCase());
    });

    function filterTree(node: TreeNode, query: string): TreeNode {
        if (!node.isFolder) {
            return node.name.toLowerCase().includes(query) ? node : { ...node, children: [] };
        }
        const filteredChildren = node.children
            .map((c) => filterTree(c, query))
            .filter((c) => c.isFolder ? c.children.length > 0 : true)
            .filter((c) => !c.isFolder || c.children.length > 0);
        return { ...node, children: filteredChildren };
    }

    // Time travel: compute vault state at a given updateId
    let timeFilteredDocs = $derived.by(() => {
        if (timeSliderValue === null || timeSliderValue >= maxUpdateId) {
            return latestDocuments;
        }
        // From all history, find the latest version per documentId at or before timeSliderValue
        const byDoc = new Map<string, DocumentVersionWithoutContent>();
        for (const v of historyVersions) {
            if (v.vaultUpdateId <= timeSliderValue) {
                const existing = byDoc.get(v.documentId);
                if (
                    !existing ||
                    v.vaultUpdateId > existing.vaultUpdateId
                ) {
                    byDoc.set(v.documentId, v);
                }
            }
        }
        return [...byDoc.values()];
    });

    let timeFilteredTree = $derived(
        buildTree(
            timeSliderValue !== null && timeSliderValue < maxUpdateId
                ? timeFilteredDocs
                : latestDocuments,
            showDeleted
        )
    );

    let displayTree = $derived(
        searchQuery ? filteredTree : timeFilteredTree
    );

    // Load data
    async function loadData() {
        const api = auth.api;
        if (!api) return;

        loadingDocs = true;
        loadingHistory = true;

        api.ping().then((ping) => {
            auth.serverVersion = ping.serverVersion;
        });

        try {
            const response = await api.fetchLatestDocuments();
            latestDocuments = response.latestDocuments;
            maxUpdateId = Number(response.lastUpdateId);
        } catch (e) {
            toasts.add("Failed to load documents", "error");
        } finally {
            loadingDocs = false;
        }

        try {
            const response = await api.fetchVaultHistory(500);
            historyVersions = response.versions;
            historyHasMore = response.hasMore;
            if (historyVersions.length > 0) {
                minUpdateId = Math.min(
                    ...historyVersions.map((v) => v.vaultUpdateId)
                );
                maxUpdateId = Math.max(
                    maxUpdateId,
                    Math.max(
                        ...historyVersions.map((v) => v.vaultUpdateId)
                    )
                );
            }
        } catch (e) {
            toasts.add("Failed to load history", "error");
        } finally {
            loadingHistory = false;
        }
    }

    async function loadMoreHistory() {
        const api = auth.api;
        if (!api || !historyHasMore) return;

        const oldest = Math.min(
            ...historyVersions.map((v) => v.vaultUpdateId)
        );
        try {
            const response = await api.fetchVaultHistory(500, oldest);
            historyVersions = [...historyVersions, ...response.versions];
            historyHasMore = response.hasMore;
            minUpdateId = Math.min(
                minUpdateId,
                ...response.versions.map((v) => v.vaultUpdateId)
            );
        } catch {
            toasts.add("Failed to load more history", "error");
        }
    }

    function selectDocument(documentId: string) {
        nav.goto({ kind: "document", documentId });
    }

    function handleRefresh() {
        loadData();
    }

    $effect(() => {
        if (auth.isAuthenticated) {
            loadData();
        }
    });
</script>

<div class="dashboard">
    <Header
        vaultId={auth.vaultId}
        serverVersion={auth.serverVersion}
        onRefresh={handleRefresh}
    />

    <div class="main-layout">
        <!-- Sidebar -->
        <aside class="sidebar">
            {#if !loadingDocs}
                <div class="sidebar-stats">
                    <div class="stat">
                        <span class="stat-value">{stats.totalDocs}</span>
                        <span class="stat-label">files</span>
                    </div>
                    <div class="stat">
                        <span class="stat-value"
                            >{formatBytes(stats.totalSize)}</span
                        >
                        <span class="stat-label">total</span>
                    </div>
                    <div class="stat">
                        <span class="stat-value">{stats.users.length}</span>
                        <span class="stat-label"
                            >user{stats.users.length !== 1 ? "s" : ""}</span
                        >
                    </div>
                </div>
            {/if}

            <div class="sidebar-search">
                <input
                    type="text"
                    placeholder="Filter files..."
                    bind:value={searchQuery}
                />
            </div>

            <div class="sidebar-controls">
                <label class="toggle-label">
                    <input
                        type="checkbox"
                        bind:checked={showDeleted}
                    />
                    Show deleted
                </label>
            </div>

            <div class="sidebar-tree">
                {#if loadingDocs}
                    <div class="loading-placeholder">Loading...</div>
                {:else}
                    <FileTree
                        node={displayTree}
                        selectedId={selectedDocumentId ?? null}
                        onSelect={selectDocument}
                    />
                {/if}
            </div>
        </aside>

        <!-- Main content -->
        <main class="content">
            {#if maxUpdateId > 0}
                <div class="time-slider-container">
                    <TimeSlider
                        min={minUpdateId}
                        max={maxUpdateId}
                        value={timeSliderValue}
                        versions={historyVersions}
                        onchange={(v) => {
                            timeSliderValue = v;
                        }}
                    />
                </div>
            {/if}

            {#if selectedDocumentId}
                <DocumentDetail
                    documentId={selectedDocumentId}
                    onClose={() => nav.goHome()}
                    onRestore={handleRefresh}
                />
            {:else}
                <div class="tabs">
                    <button
                        class="tab"
                        class:active={activeTab === "activity"}
                        onclick={() => (activeTab = "activity")}
                    >
                        Activity
                    </button>
                    <button
                        class="tab"
                        class:active={activeTab === "files"}
                        onclick={() => (activeTab = "files")}
                    >
                        Files
                    </button>
                </div>

                {#if activeTab === "activity"}
                    <ActivityFeed
                        versions={enrichedHistory}
                        loading={loadingHistory}
                        hasMore={historyHasMore}
                        onLoadMore={loadMoreHistory}
                        onSelectDocument={selectDocument}
                        onTimeTravel={(id) => {
                            timeSliderValue = id >= maxUpdateId ? null : id;
                        }}
                    />
                {:else}
                    <div class="file-list">
                        {#each latestDocuments
                            .filter((d) => showDeleted || !d.isDeleted)
                            .sort((a, b) => b.vaultUpdateId - a.vaultUpdateId) as doc}
                            <button
                                class="file-row"
                                class:deleted={doc.isDeleted}
                                onclick={() =>
                                    selectDocument(doc.documentId)}
                            >
                                <span class="file-icon"
                                    >{doc.isDeleted
                                        ? "🗑"
                                        : "📄"}</span
                                >
                                <span class="file-path"
                                    >{doc.relativePath}</span
                                >
                                <span class="file-meta">
                                    {formatBytes(doc.contentSize)}
                                    &middot;
                                    {doc.userId}
                                    &middot;
                                    {relativeTime(doc.updatedDate)}
                                </span>
                            </button>
                        {/each}
                    </div>
                {/if}
            {/if}
        </main>
    </div>
</div>

<style>
    .dashboard {
        display: flex;
        flex-direction: column;
        height: 100%;
    }

    .main-layout {
        display: flex;
        flex: 1;
        overflow: hidden;
    }

    .sidebar {
        width: 280px;
        min-width: 280px;
        border-right: 1px solid var(--border);
        display: flex;
        flex-direction: column;
        background: var(--bg-secondary);
        overflow: hidden;
    }

    .sidebar-stats {
        display: flex;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--border);
    }

    .stat {
        display: flex;
        flex-direction: column;
        align-items: center;
        flex: 1;
    }

    .stat-value {
        font-size: 16px;
        font-weight: 600;
        color: var(--text);
    }

    .stat-label {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .sidebar-search {
        padding: 8px 12px;
    }

    .sidebar-search input {
        width: 100%;
        font-size: 13px;
        padding: 6px 10px;
    }

    .sidebar-controls {
        padding: 4px 16px 8px;
    }

    .toggle-label {
        font-size: 12px;
        color: var(--text-muted);
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
    }

    .toggle-label input[type="checkbox"] {
        width: auto;
        accent-color: var(--accent);
    }

    .sidebar-tree {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
    }

    .loading-placeholder {
        padding: 16px;
        color: var(--text-muted);
        text-align: center;
        font-size: 13px;
    }

    .content {
        flex: 1;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .time-slider-container {
        padding: 8px 16px;
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
    }

    .tabs {
        display: flex;
        border-bottom: 1px solid var(--border);
        background: var(--bg-secondary);
        padding: 0 16px;
    }

    .tab {
        padding: 10px 16px;
        font-size: 13px;
        font-weight: 500;
        color: var(--text-muted);
        border-bottom: 2px solid transparent;
        transition: color 0.15s, border-color 0.15s;
    }

    .tab:hover {
        color: var(--text);
    }

    .tab.active {
        color: var(--text);
        border-bottom-color: var(--accent);
    }

    .file-list {
        flex: 1;
        overflow-y: auto;
        padding: 4px 0;
    }

    .file-row {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 8px 16px;
        text-align: left;
        transition: background 0.1s;
    }

    .file-row:hover {
        background: var(--bg-hover);
    }

    .file-row.deleted {
        opacity: 0.5;
    }

    .file-row.deleted .file-path {
        text-decoration: line-through;
    }

    .file-icon {
        font-size: 16px;
        flex-shrink: 0;
    }

    .file-path {
        font-family: var(--mono);
        font-size: 13px;
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .file-meta {
        font-size: 12px;
        color: var(--text-muted);
        white-space: nowrap;
        flex-shrink: 0;
    }
</style>
