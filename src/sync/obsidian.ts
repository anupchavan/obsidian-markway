import { normalizeFolder, normalizePath } from "./paths";
import { isRecord, stringValue } from "./primitives";

const TEMPLATE_FOLDER_KEYS = [
	"folder",
	"templateFolder",
	"template_folder",
	"templatePath",
	"template_path",
];

export function obsidianTemplateFolderFromConfig(value: unknown): string | null {
	return firstTemplateFolder([value]);
}

export function isPathInObsidianTemplateFolder(path: string, folder: string | null | undefined): boolean {
	const normalizedFolder = normalizeFolder(folder ?? "");
	if (!normalizedFolder) {
		return false;
	}

	const normalizedPath = normalizePath(path);
	return normalizedPath === normalizedFolder || normalizedPath.startsWith(`${normalizedFolder}/`);
}

function firstTemplateFolder(candidates: unknown[]): string | null {
	for (const candidate of candidates) {
		if (!isRecord(candidate)) {
			continue;
		}
		for (const key of TEMPLATE_FOLDER_KEYS) {
			const folder = stringValue(candidate[key]);
			const normalized = normalizeFolder(folder);
			if (normalized) {
				return normalized;
			}
		}
	}
	return null;
}
