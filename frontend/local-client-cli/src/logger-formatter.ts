import { LogLevel, type LogLine } from "sync-client";

// ANSI color codes
export const colors = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",

	// Foreground colors
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	magenta: "\x1b[35m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m"
} as const;

export function colorize(text: string, color: keyof typeof colors): string {
	return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Helper function to apply multiple color modifiers to text
 */
export function styleText(
	text: string,
	...modifiers: (keyof typeof colors)[]
): string {
	const prefix = modifiers.map((m) => colors[m]).join("");
	return `${prefix}${text}${colors.reset}`;
}

function formatTimestamp(date: Date): string {
	const [time] = date.toTimeString().split(" ");
	const ms = date.getMilliseconds().toString().padStart(3, "0");
	return colorize(`${time}.${ms}`, "gray");
}

function formatLevel(level: LogLevel): string {
	const levelStr = level.padEnd(7);
	switch (level) {
		case LogLevel.DEBUG:
			return colorize(levelStr, "cyan");
		case LogLevel.INFO:
			return colorize(levelStr, "green");
		case LogLevel.WARNING:
			return colorize(levelStr, "yellow");
		case LogLevel.ERROR:
			return colorize(levelStr, "red");
	}
}

function formatMessage(message: string, level: LogLevel): string {
	// Highlight important parts of the message
	let formatted = message;

	// Highlight file paths
	formatted = formatted.replace(
		/(['"])([^'"]*?\.(json|txt|md|js|ts))(['"])/g,
		(_, q1, path, _ext, q2) => q1 + colorize(path, "magenta") + q2
	);

	// Highlight numbers
	formatted = formatted.replace(/\b(\d+)\b/g, (num) => colorize(num, "cyan"));

	// Highlight patterns like /regex/
	formatted = formatted.replace(/(\/\^[^$]*\$\/)/g, (pattern) =>
		colorize(pattern, "yellow")
	);

	// Make error messages bold
	if (level === LogLevel.ERROR) {
		formatted = colorize(formatted, "bold");
	}

	return formatted;
}

export function formatLogLine(logLine: LogLine): string {
	const timestamp = formatTimestamp(logLine.timestamp);
	const level = formatLevel(logLine.level);
	const message = formatMessage(logLine.message, logLine.level);

	return `${timestamp} ${level} ${message}`;
}
