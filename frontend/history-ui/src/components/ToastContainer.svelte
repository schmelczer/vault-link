<script lang="ts">
    import { toasts } from "../lib/stores.svelte";

    const typeColors: Record<string, string> = {
        success: "var(--green)",
        error: "var(--red)",
        info: "var(--accent)"
    };
</script>

{#if toasts.items.length > 0}
    <div class="toast-container">
        {#each toasts.items as toast (toast.id)}
            <div
                class="toast"
                style="border-left-color: {typeColors[toast.type]}"
            >
                <span class="toast-message">{toast.message}</span>
                <button
                    class="toast-dismiss"
                    onclick={() => toasts.dismiss(toast.id)}
                >
                    &times;
                </button>
            </div>
        {/each}
    </div>
{/if}

<style>
    .toast-container {
        position: fixed;
        bottom: 16px;
        right: 16px;
        z-index: 9999;
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-width: 400px;
    }

    .toast {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 12px 16px;
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-left-width: 3px;
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        animation: slide-in 0.2s ease-out;
    }

    .toast-message {
        flex: 1;
        font-size: 13px;
    }

    .toast-dismiss {
        font-size: 18px;
        color: var(--text-muted);
        padding: 0 4px;
    }

    .toast-dismiss:hover {
        color: var(--text);
    }

    @keyframes slide-in {
        from {
            transform: translateX(100%);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
</style>
