const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function decodeText(content: Uint8Array): string {
    return decoder.decode(content);
}
