export class SyncResetError extends Error {
	public constructor() {
		super("SyncClient has been reset, cleaning up");
		this.name = "SyncResetError";
	}
}
