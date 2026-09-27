import { decodeText } from "./decode-text";

// Text is unlikely to contain null bytes, so we can use that to distinguish binary files.
export function isBinary(content: Uint8Array): boolean {
    if (content.includes(0)) {
        return true;
    }

    try {
        decodeText(content);
    } catch {
        return true;
    }

    return false;
}
