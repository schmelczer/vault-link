import { decodeText } from "./decode-text";

/**
 * Determine if the given content is binary (not valid UTF-8).
 *
 * Content is expected to have been normalized to UTF-8 at the read
 * boundary (via `normalizeToUtf8`), so this only checks UTF-8 validity.
 */
export function isBinary(content: Uint8Array): boolean {
    return decodeText(content) === undefined;
}
