import type { Settings } from "../persistence/settings";

export function buildVaultUrl(settings: Settings, path: string): string {
    const { vaultName, remoteUri } = settings.getSettings();
    const remoteUriWithoutTrailingSlash = remoteUri.replace(/\/+$/, "");
    const encodedVaultName = encodeURIComponent(vaultName.trim());
    return `${remoteUriWithoutTrailingSlash}/vaults/${encodedVaultName}${path}`;
}
