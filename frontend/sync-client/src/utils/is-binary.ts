// Text is unlikely to contain null bytes, so we can use that to distinguish binary files.
export function isBinary(content: Uint8Array): boolean {
    for (const byte of content) {
        if (byte === 0) {
            return true;
        }
    }

    try {
        new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
        return true;
    }

    return false;
}
