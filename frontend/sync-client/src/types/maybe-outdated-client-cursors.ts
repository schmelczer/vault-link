import type { ClientCursors } from "../services/types/ClientCursors";

export interface DocumentWithMaybeOutdatedClientCursors extends ClientCursors {
	isOutdated: boolean;
}
