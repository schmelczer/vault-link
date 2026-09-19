import { v4 as uuidv4 } from "uuid";
import { packageVersion } from "./package-version";

export function createClientId(): string {
    const platform =
        typeof navigator !== "undefined"
            ? navigator.platform // eslint-disable-line @typescript-eslint/no-deprecated
            : typeof process !== "undefined"
              ? process.platform
              : "unknown";

    return `vault-link/${packageVersion} (${uuidv4()}; ${platform})`;
}
