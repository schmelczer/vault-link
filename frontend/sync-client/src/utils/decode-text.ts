/**
 * Transcode UTF-16 content to UTF-8. Detects UTF-16 LE/BE by BOM.
 * Non-UTF-16 content (valid UTF-8 or binary) is returned as-is.
 *
 * Call this at the file-read boundary so all downstream code only
 * deals with UTF-8 bytes or binary.
 */
export function normalizeToUtf8(content: Uint8Array): Uint8Array {
    // UTF-16 LE BOM
    if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
        try {
            const text = new TextDecoder("utf-16le", {
                fatal: true
            }).decode(content);
            return new TextEncoder().encode(text);
        } catch {
            return content;
        }
    }

    // UTF-16 BE BOM
    if (content.length >= 2 && content[0] === 0xfe && content[1] === 0xff) {
        try {
            const text = new TextDecoder("utf-16be", {
                fatal: true
            }).decode(content);
            return new TextEncoder().encode(text);
        } catch {
            return content;
        }
    }

    return content;
}

/**
 * Decode UTF-8 bytes to a string.
 * Returns `undefined` if the content is not valid UTF-8.
 */
export function decodeText(content: Uint8Array): string | undefined {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
        return undefined;
    }
}
