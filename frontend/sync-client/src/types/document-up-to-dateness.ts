export enum DocumentUpToDateness {
	UpToDate = "UpToDate", // easiest case, the client can just show the cursors as-is
	Prior = "Prior", // The cursors are outdated, so the client has to guess the cursor positions based on local updates. This is only possible if this client's cursor has once been up-to-date in a given document.
	Later = "Later" // The cursors are from a future version of a document, there's no way we can accuratly show them locally.
}
