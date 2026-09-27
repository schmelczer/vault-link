import type { CursorPosition } from "reconcile-text";
import { hash } from "./utils/hash";

export interface FileSnapshot {
    content: Uint8Array;
    cursors?: CursorPosition[];
}

export interface HashedSnapshot extends FileSnapshot {
    hash: string;
}

export async function toHashedSnapshot(
    snapshot: FileSnapshot
): Promise<HashedSnapshot> {
    // Own the bytes so later adapter mutations cannot invalidate the hash
    const content = new Uint8Array(snapshot.content);

    return { content, cursors: snapshot.cursors, hash: await hash(content) };
}
