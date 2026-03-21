import murmurHash3 from "murmurhash3js-revisited";
import { decodeText } from "./decode-text";

/**
 * Normalize text content for consistent cross-platform hashing:
 * - Apply Unicode NFC normalization (macOS uses NFD, Linux/Windows use NFC)
 *
 * Binary content is returned as-is.
 */
function normalizeForHashing(content: Uint8Array): Uint8Array {
    const text = decodeText(content);
    if (text === undefined) {
        return content;
    }

    const normalized = text.normalize("NFC");
    return new TextEncoder().encode(normalized);
}

/**
 * MurmurHash3 x64 128-bit hash. Produces a 32-character hex string.
 *
 * The previous 32-bit hash had ~50% collision probability at ~77k files
 * (birthday paradox). At 128 bits, collisions are effectively impossible.
 *
 * Text content is Unicode NFC-normalized for cross-platform consistency.
 * Binary content is hashed as-is.
 */
export function hash(content: Uint8Array): string {
    const normalized = normalizeForHashing(content);
    return murmurHash3.x64.hash128(normalized);
}

export const EMPTY_HASH = hash(new Uint8Array(0));
