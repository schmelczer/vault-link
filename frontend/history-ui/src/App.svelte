<script lang="ts">
    import { auth, nav, toasts } from "./lib/stores.svelte";
    import Login from "./components/Login.svelte";
    import Dashboard from "./components/Dashboard.svelte";
    import ToastContainer from "./components/ToastContainer.svelte";
    import { ApiClient } from "./lib/api";

    let restoring = $state(true);

    $effect(() => {
        const saved = auth.tryRestore();
        if (saved) {
            const client = new ApiClient(saved.vaultId, saved.token);
            client
                .ping()
                .then((ping) => {
                    if (ping.isAuthenticated) {
                        auth.login(
                            saved.vaultId,
                            saved.token,
                            ping.serverVersion
                        );
                    }
                    restoring = false;
                })
                .catch(() => {
                    restoring = false;
                });
        } else {
            restoring = false;
        }
    });
</script>

{#if restoring}
    <div class="loading-screen">
        <div class="spinner"></div>
    </div>
{:else if !auth.isAuthenticated}
    <Login />
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
