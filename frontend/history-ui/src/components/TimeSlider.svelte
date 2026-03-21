<script lang="ts">
    import type { DocumentVersionWithoutContent } from "../lib/types";
    import { relativeTime, absoluteTime } from "../lib/stores.svelte";

    interface Props {
        min: number;
        max: number;
        value: number | null;
        versions: DocumentVersionWithoutContent[];
        onchange: (value: number | null) => void;
    }

    let { min, max, value, versions, onchange }: Props = $props();

    let isNow = $derived(value === null || value >= max);

    function handleInput(e: Event) {
        const target = e.target as HTMLInputElement;
        const v = parseInt(target.value, 10);
        if (v >= max) {
            onchange(null);
        } else {
            onchange(v);
        }
    }

    function snapToNow() {
        onchange(null);
    }

    let currentVersion = $derived(
        value !== null
            ? versions.find((v) => v.vaultUpdateId === value) ??
              versions.reduce(
                  (closest, v) =>
                      Math.abs(v.vaultUpdateId - (value ?? max)) <
                      Math.abs(
                          closest.vaultUpdateId - (value ?? max)
                      )
                          ? v
                          : closest,
                  versions[0]
              )
            : null
    );
</script>

<div class="time-slider">
    <div class="slider-label">
        <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
        >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
        </svg>
        <span class="label-text">Time Travel</span>
    </div>

    <div class="slider-track">
        <input
            type="range"
            min={min}
            max={max}
            value={value ?? max}
            oninput={handleInput}
        />
    </div>

    <div class="slider-info">
        {#if isNow}
            <span class="now-badge">Now</span>
        {:else if currentVersion}
            <span
                class="time-info"
                title={absoluteTime(currentVersion.updatedDate)}
            >
                #{value}
                &middot;
                {relativeTime(currentVersion.updatedDate)}
            </span>
        {:else}
            <span class="time-info">#{value}</span>
        {/if}
    </div>

    {#if !isNow}
        <button class="snap-btn" onclick={snapToNow} title="Back to now">
            <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
            >
                <path d="M5 12h14M12 5l7 7-7 7" />
            </svg>
        </button>
    {/if}
</div>

<style>
    .time-slider {
        display: flex;
        align-items: center;
        gap: 12px;
    }

    .slider-label {
        display: flex;
        align-items: center;
        gap: 6px;
        color: var(--text-muted);
        flex-shrink: 0;
    }

    .label-text {
        font-size: 12px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }

    .slider-track {
        flex: 1;
        min-width: 120px;
    }

    .slider-track input[type="range"] {
        width: 100%;
        height: 4px;
        appearance: none;
        background: var(--bg-tertiary);
        border-radius: 2px;
        outline: none;
        border: none;
        padding: 0;
    }

    .slider-track input[type="range"]::-webkit-slider-thumb {
        appearance: none;
        width: 14px;
        height: 14px;
        background: var(--accent);
        border-radius: 50%;
        cursor: pointer;
        transition: transform 0.1s;
    }

    .slider-track input[type="range"]::-webkit-slider-thumb:hover {
        transform: scale(1.2);
    }

    .slider-info {
        flex-shrink: 0;
        min-width: 100px;
    }

    .now-badge {
        font-size: 11px;
        font-weight: 600;
        color: var(--green);
        background: var(--green-bg);
        padding: 2px 10px;
        border-radius: 10px;
        text-transform: uppercase;
    }

    .time-info {
        font-size: 12px;
        color: var(--text-muted);
        font-family: var(--mono);
    }

    .snap-btn {
        padding: 4px;
        color: var(--accent);
        border-radius: var(--radius-sm);
        transition: background 0.15s;
        flex-shrink: 0;
    }

    .snap-btn:hover {
        background: var(--bg-hover);
    }
</style>
