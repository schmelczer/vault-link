import type { VaultUpdateId } from "../../persistence/database";

/** Map insertion order tracks the least recently used document first. */
export class FixedSizeDocumentCache {
    private currentSizeInBytes = 0;
    private readonly cache = new Map<VaultUpdateId, Uint8Array>();

    public constructor(private maxSizeInBytes: number) {}

    public get(updateId: VaultUpdateId): Uint8Array | undefined {
        const content = this.cache.get(updateId);
        if (content !== undefined) {
            this.cache.delete(updateId);
            this.cache.set(updateId, content);
        }
        return content;
    }

    public put(updateId: VaultUpdateId, content: Uint8Array): void {
        if (content.byteLength > this.maxSizeInBytes) return;
        this.currentSizeInBytes -= this.cache.get(updateId)?.byteLength ?? 0;
        this.cache.delete(updateId);
        this.cache.set(updateId, content);
        this.currentSizeInBytes += content.byteLength;
        this.fitBelowMaxSize();
    }

    public reset(): void {
        this.cache.clear();
        this.currentSizeInBytes = 0;
    }

    public resize(newMaxSizeInBytes: number): void {
        this.maxSizeInBytes = newMaxSizeInBytes;
        this.fitBelowMaxSize();
    }

    private fitBelowMaxSize(): void {
        for (const [id, content] of this.cache) {
            if (this.currentSizeInBytes <= this.maxSizeInBytes) break;
            this.cache.delete(id);
            this.currentSizeInBytes -= content.byteLength;
        }
    }
}
