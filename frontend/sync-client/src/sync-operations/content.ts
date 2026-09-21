import { base64ToBytes, bytesToBase64 } from "byte-base64";
import { reconcile } from "reconcile-text";
import type { FileSnapshot } from "../file-operations/filesystem-operations";
import type { StoredSnapshot } from "../persistence/database";
import { hash } from "../utils/hash";
import { isBinary } from "../utils/is-binary";
import { isFileTypeMergable } from "../utils/is-file-type-mergable";

export async function toStoredSnapshot(
    snapshot: FileSnapshot
): Promise<StoredSnapshot> {
    return {
        contentBase64: bytesToBase64(snapshot.content),
        cursors: snapshot.cursors,
        hash: await hash(snapshot.content)
    };
}

export function fromStoredSnapshot(snapshot: StoredSnapshot): FileSnapshot {
    return {
        content: base64ToBytes(snapshot.contentBase64),
        cursors: snapshot.cursors
    };
}

export async function mergeContent(
    path: string,
    base: StoredSnapshot | undefined,
    local: StoredSnapshot,
    remote: StoredSnapshot,
    extensions: string[]
): Promise<StoredSnapshot> {
    if (local.contentBase64 === remote.contentBase64)
        return {
            ...remote,
            cursors: local.cursors
        };

    if (!local.cursors && local.contentBase64 === base?.contentBase64)
        return remote;

    if (remote.contentBase64 === base?.contentBase64) return local;

    const inputs = [
        base?.contentBase64 ?? "",
        local.contentBase64,
        remote.contentBase64
    ].map(base64ToBytes);

    // Concurrent unmergeable edits keep the server's content.
    if (!isFileTypeMergable(path, extensions) || inputs.some(isBinary))
        return remote;

    const [parentText, localText, remoteText] = inputs.map((bytes) =>
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
    );

    const merged = reconcile(
        parentText,
        { text: localText, cursors: local.cursors },
        remoteText
    );

    return toStoredSnapshot({
        content: new TextEncoder().encode(merged.text),
        cursors: local.cursors ? merged.cursors : undefined
    });
}
