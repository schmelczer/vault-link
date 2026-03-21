<script lang="ts">
    import { auth, toasts } from "../lib/stores.svelte";
    import { ApiClient } from "../lib/api";

    let vaultId = $state("");
    let token = $state("");
    let error = $state("");
    let loading = $state(false);

    async function handleSubmit(e: Event) {
        e.preventDefault();
        if (!vaultId.trim() || !token.trim()) {
            error = "Both fields are required.";
            return;
        }
        error = "";
        loading = true;
        try {
            const client = new ApiClient(vaultId.trim(), token.trim());
            const ping = await client.ping();
            if (ping.isAuthenticated) {
                auth.login(
                    vaultId.trim(),
                    token.trim(),
                    ping.serverVersion
                );
            } else {
                error = "Authentication failed. Check your token.";
            }
        } catch (err) {
            error =
                "Cannot reach server. Check the vault name and your network.";
        } finally {
            loading = false;
        }
    }
</script>

<div class="login-page">
    <div class="login-card">
        <div class="logo">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                <path d="M2 17l10 5 10-5"/>
                <path d="M2 12l10 5 10-5"/>
            </svg>
            <h1>VaultLink</h1>
        </div>
        <p class="subtitle">Vault History Browser</p>

        <form onsubmit={handleSubmit}>
            <label>
                <span>Vault name</span>
                <input
                    type="text"
                    bind:value={vaultId}
                    placeholder="my-vault"
                    autocomplete="off"
                    disabled={loading}
                />
            </label>

            <label>
                <span>Token</span>
                <input
                    type="password"
                    bind:value={token}
                    placeholder="Enter your access token"
                    disabled={loading}
                />
            </label>

            {#if error}
                <div class="error">{error}</div>
            {/if}

            <button type="submit" class="btn-primary" disabled={loading}>
                {#if loading}
                    <span class="btn-spinner"></span>
                    Connecting...
                {:else}
                    Connect
                {/if}
            </button>
        </form>
    </div>
</div>

<style>
    .login-page {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        background: var(--bg);
    }

    .login-card {
        width: 100%;
        max-width: 400px;
        padding: 40px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 12px;
        box-shadow: var(--shadow);
    }

    .logo {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 4px;
        color: var(--text);
    }

    .logo h1 {
        font-size: 24px;
        font-weight: 600;
    }

    .subtitle {
        color: var(--text-muted);
        margin-bottom: 32px;
        font-size: 14px;
    }

    form {
        display: flex;
        flex-direction: column;
        gap: 20px;
    }

    label {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }

    label span {
        font-size: 13px;
        font-weight: 500;
        color: var(--text-muted);
    }

    input {
        width: 100%;
    }

    .error {
        color: var(--red);
        font-size: 13px;
        padding: 8px 12px;
        background: var(--red-bg);
        border-radius: var(--radius-sm);
    }

    .btn-primary {
        width: 100%;
        padding: 10px 16px;
        background: var(--accent);
        color: #fff;
        font-weight: 600;
        border-radius: var(--radius);
        transition: background 0.15s;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
    }

    .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
    }

    .btn-primary:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .btn-spinner {
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
