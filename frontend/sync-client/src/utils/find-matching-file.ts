import type { DocumentRecord } from "../sync-operations/types";
import { EMPTY_HASH } from "./hash";

// TODO: make this smarter so that offline files can be renamed & edited at the same time
export async function findMatchingFile(
    contentHash: string,
    candidates: DocumentRecord[]
): Promise<DocumentRecord | undefined> {
    if (contentHash === (await EMPTY_HASH)) {
        return undefined;
    }

    return candidates.find(
        (record) =>
            record.remoteHash !== undefined && record.remoteHash === contentHash
    );
}
