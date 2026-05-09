<script lang="ts">
    import type { TreeNode } from "../lib/view-types";
    import FileTree from "./FileTree.svelte";

    interface Props {
        node: TreeNode;
        selectedId: string | null;
        onSelect: (documentId: string) => void;
        depth?: number;
    }

    let { node, selectedId, onSelect, depth = 0 }: Props = $props();

    let expanded = $state<Record<string, boolean>>({});

    function toggle(path: string) {
        expanded[path] = !expanded[path];
    }

    function isExpanded(path: string): boolean {
        return expanded[path] ?? true;
    }
</script>

{#if node.isFolder && depth === 0}
    {#each node.children as child}
        <FileTree
            node={child}
            {selectedId}
            {onSelect}
            depth={depth + 1}
        />
    {/each}
{:else if node.isFolder}
    <div class="tree-folder">
        <button
            class="tree-item folder"
            style="padding-left: {depth * 16}px"
            onclick={() => toggle(node.path)}
        >
            <span class="expand-icon"
                >{isExpanded(node.path) ? "▾" : "▸"}</span
            >
            <span class="folder-icon">📁</span>
            <span class="node-name">{node.name}</span>
        </button>
        {#if isExpanded(node.path)}
            {#each node.children as child}
                <FileTree
                    node={child}
                    {selectedId}
                    {onSelect}
                    depth={depth + 1}
                />
            {/each}
        {/if}
    </div>
{:else}
    <button
        class="tree-item file"
        class:selected={node.document?.documentId === selectedId}
        class:deleted={node.isDeleted}
        style="padding-left: {depth * 16 + 8}px"
        onclick={() =>
            node.document && onSelect(node.document.documentId)}
    >
        <span class="file-icon">{node.isDeleted ? "○" : "●"}</span>
        <span class="node-name">{node.name}</span>
    </button>
{/if}

<style>
    .tree-item {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 3px 12px;
        font-size: 13px;
        text-align: left;
        transition: background 0.1s;
        white-space: nowrap;
        overflow: hidden;
    }

    .tree-item:hover {
        background: var(--bg-hover);
    }

    .tree-item.selected {
        background: var(--blue-bg);
    }

    .tree-item.deleted {
        opacity: 0.4;
    }

    .tree-item.deleted .node-name {
        text-decoration: line-through;
    }

    .expand-icon {
        font-size: 10px;
        width: 12px;
        flex-shrink: 0;
        color: var(--text-muted);
    }

    .folder-icon {
        font-size: 14px;
        flex-shrink: 0;
    }

    .file-icon {
        font-size: 8px;
        flex-shrink: 0;
        color: var(--text-subtle);
    }

    .node-name {
        overflow: hidden;
        text-overflow: ellipsis;
    }
</style>
