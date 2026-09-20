export function isFileTypeMergable(
    pathOrFileName: string,
    mergeableExtensions: string[]
): boolean {
    const name = pathOrFileName.split("/").at(-1) ?? "";
    const separator = name.lastIndexOf(".");
    if (separator < 0) return false;
    const fileExtension = name.slice(separator + 1);

    return mergeableExtensions.includes(fileExtension.toLowerCase());
}
