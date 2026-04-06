<script lang="ts">
    interface Props {
        oldContent: string;
        newContent: string;
        oldLabel: string;
        newLabel: string;
    }

    let { oldContent, newContent, oldLabel, newLabel }: Props = $props();

    interface DiffLine {
        type: "add" | "remove" | "context";
        content: string;
        oldLineNo: number | null;
        newLineNo: number | null;
    }

    let diffLines = $derived.by((): DiffLine[] => {
        const oldLines = oldContent.split("\n");
        const newLines = newContent.split("\n");

        // Simple line-by-line diff using LCS
        const lines: DiffLine[] = [];
        const lcs = computeLCS(oldLines, newLines);

        let oi = 0;
        let ni = 0;
        let oldLineNo = 1;
        let newLineNo = 1;

        for (const match of lcs) {
            // Remove lines before match
            while (oi < match.oldIndex) {
                lines.push({
                    type: "remove",
                    content: oldLines[oi],
                    oldLineNo: oldLineNo++,
                    newLineNo: null
                });
                oi++;
            }
            // Add lines before match
            while (ni < match.newIndex) {
                lines.push({
                    type: "add",
                    content: newLines[ni],
                    oldLineNo: null,
                    newLineNo: newLineNo++
                });
                ni++;
            }
            // Context line
            lines.push({
                type: "context",
                content: oldLines[oi],
                oldLineNo: oldLineNo++,
                newLineNo: newLineNo++
            });
            oi++;
            ni++;
        }

        // Remaining removes
        while (oi < oldLines.length) {
            lines.push({
                type: "remove",
                content: oldLines[oi],
                oldLineNo: oldLineNo++,
                newLineNo: null
            });
            oi++;
        }
        // Remaining adds
        while (ni < newLines.length) {
            lines.push({
                type: "add",
                content: newLines[ni],
                oldLineNo: null,
                newLineNo: newLineNo++
            });
            ni++;
        }

        return lines;
    });

    let stats = $derived({
        added: diffLines.filter((l) => l.type === "add").length,
        removed: diffLines.filter((l) => l.type === "remove").length
    });

    interface LCSMatch {
        oldIndex: number;
        newIndex: number;
    }

    function computeLCS(a: string[], b: string[]): LCSMatch[] {
        const m = a.length;
        const n = b.length;

        // For large files, use a simpler approach
        if (m * n > 1_000_000) {
            return simpleDiff(a, b);
        }

        const dp: number[][] = Array.from({ length: m + 1 }, () =>
            new Array(n + 1).fill(0)
        );

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                if (a[i - 1] === b[j - 1]) {
                    dp[i][j] = dp[i - 1][j - 1] + 1;
                } else {
                    dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
                }
            }
        }

        // Backtrack
        const matches: LCSMatch[] = [];
        let i = m;
        let j = n;
        while (i > 0 && j > 0) {
            if (a[i - 1] === b[j - 1]) {
                matches.unshift({ oldIndex: i - 1, newIndex: j - 1 });
                i--;
                j--;
            } else if (dp[i - 1][j] > dp[i][j - 1]) {
                i--;
            } else {
                j--;
            }
        }

        return matches;
    }

    function simpleDiff(a: string[], b: string[]): LCSMatch[] {
        // Hash-based matching for large files
        const bMap = new Map<string, number[]>();
        for (let j = 0; j < b.length; j++) {
            const arr = bMap.get(b[j]);
            if (arr) arr.push(j);
            else bMap.set(b[j], [j]);
        }

        const matches: LCSMatch[] = [];
        let lastJ = -1;
        for (let i = 0; i < a.length; i++) {
            const candidates = bMap.get(a[i]);
            if (!candidates) continue;
            for (const j of candidates) {
                if (j > lastJ) {
                    matches.push({ oldIndex: i, newIndex: j });
                    lastJ = j;
                    break;
                }
            }
        }
        return matches;
    }
</script>

<div class="diff-view">
    <div class="diff-header">
        <span class="diff-label">{oldLabel}</span>
        <span class="diff-arrow">&rarr;</span>
        <span class="diff-label">{newLabel}</span>
        <span class="diff-stats">
            <span class="diff-added">+{stats.added}</span>
            <span class="diff-removed">-{stats.removed}</span>
        </span>
    </div>
    <div class="diff-content">
        {#each diffLines as line}
            <div class="diff-line {line.type}">
                <span class="line-no old-no">
                    {line.oldLineNo ?? ""}
                </span>
                <span class="line-no new-no">
                    {line.newLineNo ?? ""}
                </span>
                <span class="line-marker">
                    {#if line.type === "add"}+{:else if line.type === "remove"}-{:else}&nbsp;{/if}
                </span>
                <span class="line-content">{line.content}</span>
            </div>
        {/each}
    </div>
</div>

<style>
    .diff-view {
        display: flex;
        flex-direction: column;
        height: 100%;
    }

    .diff-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 16px;
        background: var(--bg-secondary);
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
    }

    .diff-label {
        font-family: var(--mono);
        font-size: 12px;
        color: var(--text-muted);
    }

    .diff-arrow {
        color: var(--text-subtle);
    }

    .diff-stats {
        margin-left: auto;
        display: flex;
        gap: 8px;
        font-family: var(--mono);
        font-size: 12px;
    }

    .diff-added {
        color: var(--green);
    }

    .diff-removed {
        color: var(--red);
    }

    .diff-content {
        flex: 1;
        overflow: auto;
        font-family: var(--mono);
        font-size: 13px;
        line-height: 1.5;
    }

    .diff-line {
        display: flex;
        white-space: pre;
        min-height: 20px;
    }

    .diff-line.add {
        background: var(--green-bg);
    }

    .diff-line.remove {
        background: var(--red-bg);
    }

    .line-no {
        display: inline-block;
        width: 48px;
        text-align: right;
        padding-right: 8px;
        color: var(--text-subtle);
        user-select: none;
        flex-shrink: 0;
    }

    .line-marker {
        display: inline-block;
        width: 20px;
        text-align: center;
        flex-shrink: 0;
        user-select: none;
    }

    .diff-line.add .line-marker {
        color: var(--green);
    }

    .diff-line.remove .line-marker {
        color: var(--red);
    }

    .line-content {
        flex: 1;
        padding-right: 16px;
    }
</style>
