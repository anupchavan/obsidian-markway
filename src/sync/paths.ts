import { realpathSync } from "fs";
import { basename, extname, resolve } from "path";

export function sameVaultPath(left: string, right?: string): boolean {
	if (!right) {
		return false;
	}

	const normalizedLeft = normalizePath(left);
	const normalizedRight = normalizePath(right);
	return normalizedLeft === normalizedRight || normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

export function vaultPathKey(path: string): string {
	return normalizePath(path).toLowerCase();
}

export function titleForFile(path: string): string {
	return basename(path, extname(path)).trim() || "Journal Entry";
}

export function sanitizeFileName(value: string): string {
	const trimmed = value.trim() || "Journal Entry";
	return trimmed
		.replace(/[/:]/g, "-")
		.split("")
		.filter((character) => character.charCodeAt(0) >= 32)
		.join("")
		.replace(/\s+/g, " ")
		.slice(0, 180)
		.trim() || "Journal Entry";
}

export function normalizeFolder(value: string): string {
	return normalizePath(value.trim()).replace(/^\/+|\/+$/g, "");
}

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/\/$/g, "");
}

export function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}
