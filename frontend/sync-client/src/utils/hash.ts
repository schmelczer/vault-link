export async function hash(content: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest(
        "SHA-256",
        content as Uint8Array<ArrayBuffer>
    );
    const bytes = new Uint8Array(digest);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// SHA-256 of empty content, computed once at import time
export const EMPTY_HASH: Promise<string> = hash(new Uint8Array());
