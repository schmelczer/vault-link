<script lang="ts">
    import { auth } from "../lib/stores.svelte";
    import { relativeTime } from "../lib/stores.svelte";
    import type { VaultInfo } from "../lib/types";

    function select(vault: VaultInfo) {
        auth.selectVault(vault.name);
    }

    function formatStats(vault: VaultInfo): string {
        const docs = vault.documentCount === 1
            ? "1 document"
            : `${vault.documentCount} documents`;
        if (!vault.createdAt) return docs;
        return `${docs} · created ${relativeTime(vault.createdAt)}`;
    }
</script>

<div class="picker-page">
    <div class="picker-card">
        <div class="picker-header">
            <div class="logo">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                    <path d="M2 17l10 5 10-5"/>
                    <path d="M2 12l10 5 10-5"/>
                </svg>
                <div>
                    <h1>Select a vault</h1>
                    <p class="user-info">
                        Signed in as <strong>{auth.userName}</strong>
                        <button class="logout-link" onclick={() => auth.logout()}>Sign out</button>
                    </p>
                </div>
            </div>
        </div>

        {#if auth.availableVaults.length === 0}
            <div class="empty">
                <p>No vaults found</p>
                <p class="empty-hint">
                    Vaults are created when a sync client first connects.
                </p>
            </div>
        {:else}
            <ul class="vault-list">
                {#each auth.availableVaults as vault}
                    <li>
                        <button class="vault-item" onclick={() => select(vault)}>
                            <svg class="vault-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                            </svg>
                            <div class="vault-details">
                                <span class="vault-name">{vault.name}</span>
                                <span class="vault-stats">{formatStats(vault)}</span>
                            </div>
                            <svg class="vault-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="9 18 15 12 9 6"/>
                            </svg>
                        </button>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>
</div>

<style>
    .picker-page {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        background: var(--bg);
    }

    .picker-card {
        width: 100%;
        max-width: 480px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: var(--shadow);
        overflow: hidden;
    }

    .picker-header {
        padding: 32px 32px 24px;
    }

    .logo {
        display: flex;
        align-items: flex-start;
        gap: 12px;
        color: var(--text);
    }

    .logo svg {
        margin-top: 2px;
        flex-shrink: 0;
    }

    .logo h1 {
        font-size: 20px;
        font-weight: 600;
    }

    .user-info {
        font-size: 13px;
        color: var(--text-muted);
        margin-top: 4px;
    }

    .user-info strong {
        color: var(--text);
        font-weight: 500;
    }

    .logout-link {
        color: var(--text-subtle);
        font-size: 13px;
        text-decoration: underline;
        margin-left: 8px;
        padding: 0;
    }

    .logout-link:hover {
        color: var(--text-muted);
    }

    .vault-list {
        list-style: none;
        border-top: 1px solid var(--border);
    }

    .vault-list li + li {
        border-top: 1px solid var(--border-light);
    }

    .vault-item {
        display: flex;
        align-items: center;
        gap: 12px;
        width: 100%;
        padding: 14px 24px;
        text-align: left;
        color: var(--text);
        transition: background 0.12s;
    }

    .vault-item:hover {
        background: var(--bg-hover);
    }

    .vault-icon {
        color: var(--text-muted);
        flex-shrink: 0;
    }

    .vault-details {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
    }

    .vault-name {
        font-family: var(--mono);
        font-size: 14px;
    }

    .vault-stats {
        font-size: 12px;
        color: var(--text-subtle);
    }

    .vault-arrow {
        color: var(--text-subtle);
        flex-shrink: 0;
    }

    .empty {
        padding: 32px;
        text-align: center;
        border-top: 1px solid var(--border);
    }

    .empty p {
        color: var(--text-muted);
    }

    .empty-hint {
        font-size: 13px;
        color: var(--text-subtle);
        margin-top: 8px;
    }
</style>
