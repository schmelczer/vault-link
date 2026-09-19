export async function hash(content: Uint8Array): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new Uint8Array(content)
    );

    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
    ).join("");
}

export const EMPTY_HASH =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
