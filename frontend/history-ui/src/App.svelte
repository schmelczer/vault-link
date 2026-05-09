<script lang="ts">
    import { auth, nav, toasts } from "./lib/stores.svelte";
    import { listVaults } from "./lib/api";
    import Login from "./components/Login.svelte";
    import VaultPicker from "./components/VaultPicker.svelte";
    import Dashboard from "./components/Dashboard.svelte";
    import ToastContainer from "./components/ToastContainer.svelte";

    let restoring = $state(true);

    $effect(() => {
        const saved = auth.tryRestore();
        if (!saved) {
            restoring = false;
            return;
        }
        listVaults(saved.token)
            .then((response) => {
                auth.authenticate(
                    saved.token,
                    response.userName,
                    response.vaults
                );
                if (
                    saved.vaultId &&
                    response.vaults.some(
                        (v) => v.name === saved.vaultId
                    )
                ) {
                    auth.selectVault(saved.vaultId);
                }
                restoring = false;
            })
            .catch(() => {
                restoring = false;
            });
    });
</script>

{#if restoring}
    <div class="loading-screen">
        <div class="spinner"></div>
    </div>
{:else if !auth.token}
    <Login />
{:else if !auth.isAuthenticated}
    <VaultPicker />
{:else}
    <Dashboard
        selectedDocumentId={nav.current.kind === "document" ? nav.current.documentId : undefined}
    />
{/if}

<ToastContainer />

<style>
    .loading-screen {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
    }

    .spinner {
        width: 32px;
        height: 32px;
        border: 3px solid var(--bg-tertiary);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
