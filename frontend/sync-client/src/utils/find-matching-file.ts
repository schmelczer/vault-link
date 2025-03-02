import type { DocumentMetadata, RelativePath } from "../persistence/database";
import { EMPTY_HASH } from "./hash";

// TODO: make this smarter so that offline files can be renamed & edited at the same time
export function findMatchingFile(
	contentHash: string,
	candidates: [RelativePath, DocumentMetadata][]
): [RelativePath, DocumentMetadata] | undefined {
	if (contentHash === EMPTY_HASH) {
		return undefined;
	}

	return candidates.find(([_, metadata]) => metadata.hash === contentHash);
}
