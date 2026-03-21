<script lang="ts">
    interface Props {
        title: string;
        message: string;
        confirmLabel: string;
        destructive?: boolean;
        loading?: boolean;
        onConfirm: () => void;
        onCancel: () => void;
    }

    let {
        title,
        message,
        confirmLabel,
        destructive = false,
        loading = false,
        onConfirm,
        onCancel
    }: Props = $props();

    function handleKeydown(e: KeyboardEvent) {
        if (e.key === "Escape") onCancel();
    }
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="backdrop" onclick={onCancel} role="presentation">
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div
        class="dialog"
        onclick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
    >
        <h3 class="dialog-title">{title}</h3>
        <p class="dialog-message">{message}</p>
        <div class="dialog-actions">
            <button class="btn-cancel" onclick={onCancel} disabled={loading}>
                Cancel
            </button>
            <button
                class="btn-confirm"
                class:destructive
                onclick={onConfirm}
                disabled={loading}
            >
                {#if loading}
                    <span class="btn-spinner"></span>
                {/if}
                {confirmLabel}
            </button>
        </div>
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        animation: fade-in 0.15s ease-out;
    }

    .dialog {
        background: var(--bg-secondary);
        border: 1px solid var(--border);
        border-radius: 12px;
        padding: 24px;
        max-width: 480px;
        width: calc(100% - 32px);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
        animation: scale-in 0.2s ease-out;
    }

    .dialog-title {
        font-size: 16px;
        font-weight: 600;
        margin-bottom: 12px;
    }

    .dialog-message {
        font-size: 14px;
        color: var(--text-muted);
        line-height: 1.5;
        margin-bottom: 24px;
    }

    .dialog-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
    }

    .btn-cancel {
        padding: 8px 16px;
        border: 1px solid var(--border);
        border-radius: var(--radius);
        color: var(--text-muted);
        transition: background 0.15s;
    }

    .btn-cancel:hover:not(:disabled) {
        background: var(--bg-hover);
        color: var(--text);
    }

    .btn-confirm {
        padding: 8px 16px;
        background: var(--accent);
        color: #fff;
        font-weight: 600;
        border-radius: var(--radius);
        transition: background 0.15s;
        display: flex;
        align-items: center;
        gap: 6px;
    }

    .btn-confirm:hover:not(:disabled) {
        background: var(--accent-hover);
    }

    .btn-confirm.destructive {
        background: var(--red);
    }

    .btn-confirm.destructive:hover:not(:disabled) {
        background: #f97583;
    }

    .btn-confirm:disabled,
    .btn-cancel:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .btn-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: #fff;
        border-radius: 50%;
        animation: spin 0.6s linear infinite;
    }

    @keyframes fade-in {
        from { opacity: 0; }
        to { opacity: 1; }
    }

    @keyframes scale-in {
        from { transform: scale(0.95); opacity: 0; }
        to { transform: scale(1); opacity: 1; }
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }
</style>
