import { compareDate, compareNumber, compareValue, canCompareDate, isDateOperator, isNumberOperator, splitValues } from "./compare";
import { normalizeFolderValue } from "./definitions";
import type { Filter, FilterGroup, FilterOperator, FrontmatterRecord, FrontmatterValue, RuleApp, RuleFile } from "./types";

const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

export function checkRules(
	app: RuleApp,
	group: FilterGroup,
	file: RuleFile,
	frontmatter?: FrontmatterRecord
): boolean {
	if (!group.conditions.length) {
		return true;
	}

	const results = group.conditions.map((condition) =>
		condition.type === "group"
			? checkRules(app, condition, file, frontmatter)
			: evaluateFilter(app, condition, file, frontmatter)
	);

	if (group.operator === "AND") {
		return results.every(Boolean);
	}
	if (group.operator === "OR") {
		return results.some(Boolean);
	}
	if (group.operator === "NOR") {
		return results.every((result) => !result);
	}
	return true;
}

function evaluateFilter(app: RuleApp, filter: Filter, file: RuleFile, frontmatter?: FrontmatterRecord): boolean {
	const filterValue = filter.value ?? "";
	if (filter.field === "file") {
		return evaluateFileOperator(app, file, frontmatter, filter.operator, filterValue);
	}

	const targetValue = valueForField(app, filter.field, file, frontmatter);
	if (isDateOperator(filter.operator) && canCompareDate(targetValue)) {
		return compareDate(targetValue, filter.operator, filterValue);
	}
	if (isNumberOperator(filter.operator)) {
		return compareNumber(targetValue, filter.operator, filterValue);
	}
	return compareValue(targetValue, filter.operator, filterValue);
}

function evaluateFileOperator(
	app: RuleApp,
	file: RuleFile,
	frontmatter: FrontmatterRecord | undefined,
	operator: FilterOperator,
	filterValue: string
): boolean {
	switch (operator) {
		case "links to":
		case "does not link to": return evaluateLinksTo(app, file, frontmatter, operator, filterValue);
		case "in folder":
		case "is not in folder": {
			const isInFolder = isFileInFolder(file, filterValue);
			return operator === "in folder" ? isInFolder : !isInFolder;
		}
		case "has tag":
		case "does not have tag": return evaluateHasTag(app, file, frontmatter, operator, filterValue);
		case "has property":
		case "does not have property": {
			const propertyName = filterValue.trim();
			const hasProperty = Boolean(propertyName && frontmatter && propertyName in frontmatter);
			return operator === "has property" ? hasProperty : !hasProperty;
		}
		default: return false;
	}
}

function valueForField(
	app: RuleApp,
	field: string,
	file: RuleFile,
	frontmatter: FrontmatterRecord | undefined
): FrontmatterValue {
	if (field === "file.name") return file.name;
	if (field === "file.basename") return file.basename;
	if (field === "file.path") return file.path;
	if (field === "file.folder") return file.parent?.path ?? "";
	if (field === "file.extension") return file.extension;
	if (field === "file.size") return file.stat.size;
	if (field === "file.ctime") return file.stat.ctime;
	if (field === "file.mtime") return file.stat.mtime;
	if (field === "file links") return getResolvedOutgoingPaths(app, file, frontmatter).map((path) => path.replace(/\.md$/, ""));
	if (field === "file tags") return getFileTags(app, file, frontmatter);
	if (field === "aliases") {
		const aliases = frontmatter?.aliases;
		return Array.isArray(aliases) ? aliases : aliases ? [aliases] : [];
	}
	return frontmatter?.[field] ?? "";
}

function evaluateLinksTo(
	app: RuleApp,
	file: RuleFile,
	frontmatter: FrontmatterRecord | undefined,
	operator: FilterOperator,
	filterValue: string
): boolean {
	const targetFile = app.metadataCache.getFirstLinkpathDest?.(filterValue, file.path);
	if (!targetFile) {
		return operator === "does not link to";
	}
	const hasLink = getResolvedOutgoingPaths(app, file, frontmatter).includes(targetFile.path);
	return operator === "links to" ? hasLink : !hasLink;
}

function evaluateHasTag(
	app: RuleApp,
	file: RuleFile,
	frontmatter: FrontmatterRecord | undefined,
	operator: FilterOperator,
	filterValue: string
): boolean {
	const filterTags = splitValues(filterValue);
	if (!filterTags.length) {
		return operator === "does not have tag";
	}
	const fileTags = getFileTags(app, file, frontmatter);
	const hasAnyTag = filterTags.some((filterTag) =>
		fileTags.some((fileTag) =>
			fileTag === filterTag
			|| fileTag.startsWith(`${filterTag}/`)
			|| filterTag.startsWith(`${fileTag}/`)
		)
	);
	return operator === "has tag" ? hasAnyTag : !hasAnyTag;
}

function getFileTags(app: RuleApp, file: RuleFile, frontmatter?: FrontmatterRecord): string[] {
	const cache = app.metadataCache.getFileCache(file);
	const bodyTags = (cache?.tags ?? []).map((tag) => tag.tag.replace(/^#/, ""));
	const rawTags = frontmatter?.tags;
	const frontmatterTags = Array.isArray(rawTags) ? rawTags : rawTags ? [rawTags] : [];
	return [...bodyTags, ...frontmatterTags.map((tag) => String(tag).replace(/^#/, ""))];
}

function getResolvedOutgoingPaths(app: RuleApp, file: RuleFile, frontmatter?: FrontmatterRecord): string[] {
	const paths: string[] = [];
	for (const link of app.metadataCache.getFileCache(file)?.links ?? []) {
		const resolved = app.metadataCache.getFirstLinkpathDest?.(link.link, file.path);
		if (resolved?.path) {
			paths.push(resolved.path);
		}
	}

	if (frontmatter) {
		for (const value of Object.values(frontmatter)) {
			for (const linkText of extractFrontmatterLinks(value)) {
				const resolved = app.metadataCache.getFirstLinkpathDest?.(linkText, file.path);
				if (resolved?.path) {
					paths.push(resolved.path);
				}
			}
		}
	}
	return [...new Set(paths)];
}

function extractFrontmatterLinks(value: FrontmatterValue): string[] {
	if (value === undefined || value === null) {
		return [];
	}
	if (Array.isArray(value)) {
		return value.flatMap((item) => extractFrontmatterLinks(item));
	}
	const results: string[] = [];
	const source = String(value);
	let match: RegExpExecArray | null;
	WIKILINK_PATTERN.lastIndex = 0;
	while ((match = WIKILINK_PATTERN.exec(source)) !== null) {
		results.push((match[1] ?? "").split("|")[0] ?? "");
	}
	return results.filter(Boolean);
}

function isFileInFolder(file: RuleFile, folder: string): boolean {
	const target = normalizeFolderValue(folder);
	if (!target) {
		return false;
	}
	const fileFolder = normalizeFolderValue(file.parent?.path ?? "");
	return fileFolder === target || fileFolder.startsWith(`${target}/`);
}
