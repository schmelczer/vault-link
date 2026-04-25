export async function hash(content: Uint8Array): Promise<string> {
    // Copy into a fresh ArrayBuffer-backed Uint8Array so the buffer type
    // matches `BufferSource`/`Uint8Array<ArrayBuffer>` expected by digest.
    const owned = new Uint8Array(content);
    const digest = await crypto.subtle.digest("SHA-256", owned);
    const bytes = new Uint8Array(digest);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// SHA-256 of empty content, computed once at import time
export const EMPTY_HASH: Promise<string> = hash(new Uint8Array());
