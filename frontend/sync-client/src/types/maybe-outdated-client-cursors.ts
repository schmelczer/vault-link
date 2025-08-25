import type { ClientCursors } from "../services/types/ClientCursors";

export interface MaybeOutdatedClientCursors extends ClientCursors {
	isOutdated: boolean;
}
