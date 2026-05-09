<script lang="ts">
    import type { VersionEvent } from "../lib/view-types";
    import {
        absoluteTime,
        formatBytes
    } from "../lib/stores.svelte";

    interface Props {
        versions: VersionEvent[];
        loading: boolean;
        hasMore: boolean;
        onLoadMore: () => void;
        onSelectDocument: (documentId: string) => void;
        onTimeTravel: (vaultUpdateId: number) => void;
    }

    let {
        versions,
        loading,
        hasMore,
        onLoadMore,
        onSelectDocument,
        onTimeTravel
    }: Props = $props();

    function timeOfDay(dateStr: string): string {
        return new Date(dateStr).toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit"
        });
    }

    // Group by day
    let grouped = $derived.by(() => {
        const groups: { date: string; items: VersionEvent[] }[] = [];
        const sortedDesc = [...versions].sort(
            (a, b) => b.vaultUpdateId - a.vaultUpdateId
        );

        for (const v of sortedDesc) {
            const date = new Date(v.updatedDate).toLocaleDateString(
                "en-US",
                { month: "long", day: "numeric", year: "numeric" }
            );
            const last = groups.at(-1);
            if (last && last.date === date) {
                last.items.push(v);
            } else {
                groups.push({ date, items: [v] });
            }
        }
        return groups;
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

<div class="feed">
    {#if loading && versions.length === 0}
        <div class="feed-loading">Loading activity...</div>
    {:else if versions.length === 0}
        <div class="feed-empty">
            No activity yet. Documents will appear here as sync clients
            make changes.
        </div>
    {:else}
        {#each grouped as group}
            <div class="day-group">
                <div class="day-header">{group.date}</div>
                <div class="items-list">
                {#each group.items as event}
                    <div class="feed-item">
                        <button
                            class="feed-item-main"
                            onclick={() =>
                                onSelectDocument(event.documentId)}
                        >
                            <div class="feed-timeline">
                                <div
                                    class="timeline-dot"
                                    style="background: {actionColors[
                                        event.action
                                    ]}"
                                ></div>
                            </div>
                            <div class="feed-content">
                                <div class="feed-header">
                                    <span
                                        class="action-pill"
                                        style="color: {actionColors[
                                            event.action
                                        ]}; background: {actionBgColors[
                                            event.action
                                        ]}"
                                    >
                                        {event.action}
                                    </span>
                                    <span class="feed-path">
                                        {#if event.action === "renamed" && event.previousPath}
                                            <span class="prev-path"
                                                >{event.previousPath}</span
                                            >
                                            <span class="arrow"
                                                >&rarr;</span
                                            >
                                        {/if}
                                        <span
                                            class:deleted={event.action ===
                                                "deleted"}
                                        >
                                            {event.relativePath}
                                        </span>
                                    </span>
                                </div>
                                <div class="feed-meta">
                                    <span class="feed-user"
                                        >{event.userId}</span
                                    >
                                    <span class="feed-dot"
                                        >&middot;</span
                                    >
                                    <span class="feed-size"
                                        >{formatBytes(
                                            event.contentSize
                                        )}</span
                                    >
                                </div>
                            </div>
                        </button>
                        <button
                            class="feed-time-btn"
                            title="Time travel to {absoluteTime(event.updatedDate)}"
                            onclick={(e) => {
                                e.stopPropagation();
                                onTimeTravel(event.vaultUpdateId);
                            }}
                        >
                            {timeOfDay(event.updatedDate)}
                        </button>
                    </div>
                {/each}
                </div>
            </div>
        {/each}

        {#if hasMore}
            <div class="load-more">
                <button class="load-more-btn" onclick={onLoadMore}>
                    Load older activity
                </button>
            </div>
        {/if}
    {/if}
</div>

<style>
    .feed {
        flex: 1;
        overflow-y: auto;
        padding: 0 0 16px;
    }

    .feed-loading,
    .feed-empty {
        padding: 48px 16px;
        text-align: center;
        color: var(--text-muted);
    }

    .day-group {
        margin-bottom: 8px;
    }

    .day-header {
        position: sticky;
        top: 0;
        z-index: 1;
        padding: 8px 16px;
        font-size: 12px;
        font-weight: 600;
        color: var(--text-muted);
        background: var(--bg);
        border-bottom: 1px solid var(--border-light);
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .feed-item {
        display: flex;
        align-items: stretch;
        width: 100%;
        transition: background 0.1s;
    }

    .feed-item:hover {
        background: var(--bg-hover);
    }

    .feed-item-main {
        display: flex;
        gap: 12px;
        flex: 1;
        min-width: 0;
        padding: 10px 0 10px 16px;
        text-align: left;
    }

    .items-list {
        position: relative;
    }

    .items-list::before {
        content: "";
        position: absolute;
        left: 21px;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--border);
    }

    .feed-timeline {
        display: flex;
        flex-direction: column;
        align-items: center;
        width: 12px;
        flex-shrink: 0;
        padding-top: 6px;
        position: relative;
    }

    .timeline-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
    }

    .feed-content {
        flex: 1;
        min-width: 0;
    }

    .feed-header {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
    }

    .action-pill {
        font-size: 11px;
        font-weight: 600;
        padding: 1px 8px;
        border-radius: 10px;
        text-transform: uppercase;
        letter-spacing: 0.3px;
        flex-shrink: 0;
    }

    .feed-path {
        font-family: var(--mono);
        font-size: 13px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .prev-path {
        color: var(--text-muted);
        text-decoration: line-through;
    }

    .arrow {
        color: var(--text-subtle);
        margin: 0 4px;
    }

    .deleted {
        text-decoration: line-through;
        opacity: 0.6;
    }

    .feed-meta {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-top: 4px;
        font-size: 12px;
        color: var(--text-muted);
    }

    .feed-dot {
        color: var(--text-subtle);
    }

    .feed-time-btn {
        display: flex;
        align-items: center;
        padding: 0 16px;
        font-size: 12px;
        font-family: var(--mono);
        color: var(--text-muted);
        white-space: nowrap;
        flex-shrink: 0;
        border-left: 1px solid transparent;
        transition: color 0.15s, border-color 0.15s;
    }

    .feed-time-btn:hover {
        color: var(--accent);
        border-left-color: var(--border-light);
    }

    .load-more {
        padding: 16px;
        text-align: center;
    }

    .load-more-btn {
        padding: 8px 20px;
        font-size: 13px;
        color: var(--accent);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        transition: background 0.15s;
    }

    .load-more-btn:hover {
        background: var(--bg-hover);
    }
</style>
