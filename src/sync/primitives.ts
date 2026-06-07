import { createHash } from "crypto";

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function isFileExistsError(value: unknown): boolean {
	const message = describeUnknown(value).toLowerCase();
	return message.includes("file already exists") || message.includes("eexist");
}

export function describeUnknown(value: unknown): string {
	if (value instanceof Error) {
		return value.message;
	}
	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value) ?? "Unknown error";
	} catch {
		return "Unknown error";
	}
}

export function explainMarkwayError(value: unknown): string {
	const message = describeUnknown(value);
	if (
		message.includes("group.com.apple.moments")
		|| message.includes("Sandbox access to file-read-data denied")
		|| message.includes("Apple Journal access was denied")
		|| message.includes("moments.sqlite")
	) {
		return [
			"macOS denied Markway.app access to Apple Journal.",
			"Grant Full Disk Access to Markway.app, fully quit and reopen Markway.app, then start the bridge again.",
		].join(" ");
	}

	return message;
}

export function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
