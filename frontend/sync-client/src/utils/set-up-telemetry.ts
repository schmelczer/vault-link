import * as Sentry from "@sentry/browser";

// @ts-expect-error, injected by webpack
const packageVersion = __CURRENT_VERSION__; // eslint-disable-line

export const setUpTelemetry = (): (() => void) => {
    Sentry.init({
        dsn: "https://a9bb2b9151bb450ca86b936436e356c4@bugs.schmelczer.dev/1",
        release: `sync-client@${packageVersion}`,
        sendDefaultPii: true,
        integrations: [],
        tracesSampleRate: 0
    });

    Sentry.captureMessage("Initialised telemetry");

    const onError = (event: ErrorEvent): void => {
        Sentry.captureException(event.error, {
            extra: {
                message: event.message,
                filename: event.filename,
                lineno: event.lineno,
                colno: event.colno
            }
        });
    };
    window.addEventListener("error", onError);

    const onUnhandledRejection = (event: PromiseRejectionEvent): void => {
        Sentry.captureException(event.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return (): void => {
        window.removeEventListener("error", onError);
        window.removeEventListener("unhandledrejection", onUnhandledRejection);
        Sentry.close(5000).catch(() => {
            // Ignore errors during shutdown
        });
    };
};
