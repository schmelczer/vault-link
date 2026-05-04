export async function hash(content: Uint8Array): Promise<string> {
    // Re-wrap into a fresh Uint8Array<ArrayBuffer> so SubtleCrypto's
    // BufferSource overload accepts it without an unsafe type assertion.
    // The lib types require an ArrayBuffer-backed view; the source may
    // be backed by SharedArrayBuffer in some runtimes.
    const buffer = new ArrayBuffer(content.byteLength);
    new Uint8Array(buffer).set(content);
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const bytes = new Uint8Array(digest);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// SHA-256 of empty content, computed once at import time
export const EMPTY_HASH: Promise<string> = hash(new Uint8Array());
