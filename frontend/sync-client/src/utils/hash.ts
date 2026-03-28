export async function hash(content: Uint8Array): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", content);
    const bytes = new Uint8Array(digest);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const EMPTY_HASH = await hash(new Uint8Array(0));
