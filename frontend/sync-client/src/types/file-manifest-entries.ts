import type { DocumentId, RelativePath } from "../persistence/database";

export type FileManifestEntries = Record<DocumentId, RelativePath>;
