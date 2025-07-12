export function isFileTypeMergable(pathOrFileName: string): boolean {
	const parts = pathOrFileName.split(".");
	const fileExtension = parts.at(-1) || "";

	return ["md", "txt"].includes(fileExtension.toLowerCase());
}
