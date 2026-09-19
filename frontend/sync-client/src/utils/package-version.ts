declare const __CURRENT_VERSION__: string;

/** Webpack replaces this identifier in bundles; source imports use a stable fallback. */
export const packageVersion =
    typeof __CURRENT_VERSION__ === "undefined"
        ? "development"
        : __CURRENT_VERSION__;
