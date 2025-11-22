import { MERGABLE_FILE_TYPES } from "../consts";

export function isFileTypeMergable(pathOrFileName: string): boolean {
	const parts = pathOrFileName.split(".");
	const fileExtension = parts.at(-1) ?? "";

	return MERGABLE_FILE_TYPES.includes(fileExtension.toLowerCase());
}
