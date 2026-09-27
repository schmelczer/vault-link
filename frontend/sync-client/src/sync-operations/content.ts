import type { RelativePath } from "../persistence/database";
import { reconcile } from "reconcile-text";
import { toHashedSnapshot, type HashedSnapshot } from "../snapshot";
import { isBinary } from "../utils/is-binary";
import { isFileTypeMergeable } from "../utils/is-file-type-mergeable";
import { decodeText } from "../utils/decode-text";

export async function mergeContent(
    path: RelativePath,
    base: HashedSnapshot | undefined,
    local: HashedSnapshot,
    remote: HashedSnapshot,
    extensions: string[]
): Promise<HashedSnapshot> {
    if (local.hash === remote.hash) {
        return {
            ...remote,
            cursors: local.cursors
        };
    }

    if (!local.cursors && local.hash === base?.hash) {
        return remote;
    }

    if (remote.hash === base?.hash) {
        return local;
    }

    const inputs = [
        base?.content ?? new Uint8Array(),
        local.content,
        remote.content
    ];

    // Concurrent unmergeable edits keep the server's content.
    if (!isFileTypeMergeable(path, extensions) || inputs.some(isBinary)) {
        return remote;
    }

    const parentText = decodeText(base?.content ?? new Uint8Array());
    const localText = decodeText(local.content);
    const remoteText = decodeText(remote.content);

    const merged = reconcile(
        parentText,
        { text: localText, cursors: local.cursors },
        remoteText
    );

    return toHashedSnapshot({
        content: new TextEncoder().encode(merged.text),
        cursors: local.cursors ? merged.cursors : undefined
    });
}
