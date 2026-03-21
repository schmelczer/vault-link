<script lang="ts">
    import { auth } from "../lib/stores.svelte";

    interface Props {
        vaultId: string;
        serverVersion: string;
        onRefresh: () => void;
    }

    let { vaultId, serverVersion, onRefresh }: Props = $props();
</script>

<header class="header">
    <div class="header-left">
        <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
        >
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
        </svg>
        <span class="header-title">VaultLink</span>
        <span class="header-sep">/</span>
        <span class="header-vault">{vaultId}</span>
    </div>

    <div class="header-right">
        <span class="server-version">v{serverVersion}</span>
        <button class="header-btn" onclick={onRefresh} title="Refresh">
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
            >
                <path
                    d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"
                />
            </svg>
        </button>
        <button
            class="header-btn"
            onclick={() => auth.logout()}
            title="Disconnect"
        >
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
            >
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
        </button>
    </div>
</header>

<style>
    .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        height: 48px;
        padding: 0 16px;
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
    }

    .header-left {
        display: flex;
        align-items: center;
        gap: 8px;
        color: var(--text);
    }

    .header-title {
        font-weight: 600;
        font-size: 15px;
    }

    .header-sep {
        color: var(--text-subtle);
    }

    .header-vault {
        font-family: var(--mono);
        font-size: 14px;
        color: var(--accent);
    }

    .header-right {
        display: flex;
        align-items: center;
        gap: 8px;
    }

    .server-version {
        font-size: 12px;
        color: var(--text-subtle);
        font-family: var(--mono);
    }

    .header-btn {
        padding: 6px;
        border-radius: var(--radius-sm);
        color: var(--text-muted);
        transition: color 0.15s, background 0.15s;
    }

    .header-btn:hover {
        color: var(--text);
        background: var(--bg-hover);
    }
</style>
