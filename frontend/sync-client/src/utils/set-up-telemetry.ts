import * as Sentry from "@sentry/browser";
import { init as plausibleInit } from "@plausible-analytics/tracker";

export const setUpTelemetry = (): (() => void) => {
	plausibleInit({
		domain: "vault-link",
		endpoint: "https://stats.schmelczer.dev/status",
		autoCapturePageviews: true,
		captureOnLocalhost: true,
		logging: true
	});

	Sentry.init({
		dsn: "https://56accd39d92442e788a457a04623cf57@bugs.schmelczer.dev/1",
		skipBrowserExtensionCheck: false
	});

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
		Sentry.close(5000);
		// unloading plausible requires reloading
	};
};
