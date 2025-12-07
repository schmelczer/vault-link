export function isFileTypeMergable(
    pathOrFileName: string,
    mergeableExtensions: string[]
): boolean {
    const parts = pathOrFileName.split(".");
    const fileExtension = parts.at(-1) ?? "";

    return mergeableExtensions.includes(fileExtension.toLowerCase());
}
