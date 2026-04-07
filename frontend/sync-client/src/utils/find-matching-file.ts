import type { DocumentRecord, RelativePath } from "../sync-operations/types";
import { EMPTY_HASH } from "./hash";

// TODO: make this smarter so that offline files can be renamed & edited at the same time
export async function findMatchingFile(
    contentHash: string,
    candidates: { path: RelativePath; record: DocumentRecord }[]
): Promise<{ path: RelativePath; record: DocumentRecord } | undefined> {
    if (contentHash === await EMPTY_HASH) {
        return undefined;
    }

    return candidates.find(({ record }) => record.remoteHash === contentHash);
}
