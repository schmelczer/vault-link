// Local-only files displaced by `FileOperations.ensureClearPath` are named
// `conflict-<uuid>-<originalName>`. The UUID is a full RFC-4122 v4 value so
// a user-authored filename that happens to start with `conflict-` doesn't
// get misclassified. The leading `(?:^|\/)` and trailing `[^/]*$` anchor the
// match to the final path segment so intermediate directories named after
// old conflict files (if a user renames one into a directory) don't ignore
// everything beneath them.
export const CONFLICT_PATH_REGEX =
    /(?:^|\/)conflict-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[^/]*$/u;

// Safe segment length for common filesystems (ext4 / NTFS / APFS all cap
// at 255 bytes). `conflict-<36-char-uuid>-` adds 46 bytes; reserve a few
// extra bytes for a future prefix bump and leave room for multi-byte UTF-8
// characters in the original name.
const CONFLICT_PREFIX_LEN = "conflict-".length + 36 + 1;
const MAX_SEGMENT_BYTES = 255;
const MAX_ORIGINAL_BYTES = MAX_SEGMENT_BYTES - CONFLICT_PREFIX_LEN - 4;

export function buildConflictFileName(fileName: string): string {
    // Truncate the original name if keeping it whole would bust the
    // filesystem's segment-length cap. Preserve the trailing extension
    // so the file is still recognizable / openable.
    const safeName = truncateFileNameToByteLimit(fileName, MAX_ORIGINAL_BYTES);
    return `conflict-${crypto.randomUUID()}-${safeName}`;
}

function truncateFileNameToByteLimit(
    fileName: string,
    maxBytes: number
): string {
    const encoder = new TextEncoder();
    if (encoder.encode(fileName).byteLength <= maxBytes) return fileName;

    const dotIndex = fileName.lastIndexOf(".");
    // Dotfile (starts with "." and nothing else) → no extension to preserve.
    const hasExtension = dotIndex > 0;
    const extension = hasExtension ? fileName.slice(dotIndex) : "";
    const stem = hasExtension ? fileName.slice(0, dotIndex) : fileName;

    const extensionBytes = encoder.encode(extension).byteLength;
    const stemBudget = Math.max(0, maxBytes - extensionBytes);

    // Walk the stem by grapheme cluster so we never split an emoji sequence
    // (e.g. ZWJ families, skin-tone modifiers) or a base+combining-mark pair.
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let truncatedStem = "";
    let usedBytes = 0;
    for (const { segment } of segmenter.segment(stem)) {
        const segmentBytes = encoder.encode(segment).byteLength;
        if (usedBytes + segmentBytes > stemBudget) break;
        truncatedStem += segment;
        usedBytes += segmentBytes;
    }
    return truncatedStem + extension;
}
