export type FilterOperator =
	| "contains" | "does not contain"
	| "contains any of" | "does not contain any of"
	| "contains all of" | "does not contain all of"
	| "is" | "is not"
	| "is exactly" | "is not exactly"
	| "starts with" | "does not start with"
	| "ends with" | "does not end with"
	| "is empty" | "is not empty"
	| "links to" | "does not link to"
	| "in folder" | "is not in folder"
	| "has tag" | "does not have tag"
	| "has property" | "does not have property"
	| "on" | "not on"
	| "before" | "on or before"
	| "after" | "on or after"
	| "=" | "!=" | "≠" | "<" | "<=" | "≤" | ">" | ">=" | "≥";

export type FilterConjunction = "AND" | "OR" | "NOR";

export type PropertyType = "text" | "number" | "date" | "datetime" | "list" | "checkbox" | "file" | "unknown";

export interface Filter {
	type: "filter";
	field: string;
	operator: FilterOperator;
	value?: string;
}

export interface FilterGroup {
	type: "group";
	operator: FilterConjunction;
	conditions: Array<Filter | FilterGroup>;
}

export interface PropertyDef {
	key: string;
	type: PropertyType;
}

export interface RuleFile {
	name: string;
	basename: string;
	path: string;
	extension: string;
	parent?: { path: string } | null;
	stat: {
		size: number;
		ctime: number;
		mtime: number;
	};
}

export type FrontmatterValue =
	| string
	| number
	| boolean
	| Array<string | number | boolean>
	| null
	| undefined;

export type FrontmatterRecord = Record<string, FrontmatterValue>;

export interface RuleFileCache {
	tags?: Array<{ tag: string }>;
	links?: Array<{ link: string }>;
	frontmatter?: FrontmatterRecord;
}

export interface RuleMetadataCache {
	getFileCache(file: RuleFile): RuleFileCache | null | undefined;
	getFirstLinkpathDest?(linkpath: string, sourcePath: string): RuleFile | null;
}

export interface RuleApp {
	metadataCache: RuleMetadataCache;
	vault?: {
		getMarkdownFiles?(): RuleFile[];
	};
	metadataTypeManager?: {
		getAssignedType?(key: string): string | undefined;
	};
}

const TYPE_OPERATORS: Record<PropertyType, FilterOperator[]> = {
	text: [
		"is",
		"is not",
		"starts with",
		"ends with",
		"is empty",
		"contains",
		"contains any of",
		"contains all of",
		"does not start with",
		"does not end with",
		"is not empty",
		"does not contain",
		"does not contain any of",
		"does not contain all of",
	],
	list: [
		"is exactly",
		"is not exactly",
		"is empty",
		"contains",
		"contains any of",
		"contains all of",
		"is not empty",
		"does not contain",
		"does not contain any of",
		"does not contain all of",
	],
	number: ["=", "!=", "<", "<=", ">", ">=", "is empty", "is not empty"],
	date: ["on", "not on", "before", "on or before", "after", "on or after", "is empty", "is not empty"],
	datetime: ["on", "not on", "before", "on or before", "after", "on or after", "is empty", "is not empty"],
	checkbox: ["is", "is not", "is empty", "is not empty"],
	file: [
		"links to",
		"in folder",
		"has tag",
		"has property",
		"does not link to",
		"is not in folder",
		"does not have tag",
		"does not have property",
	],
	unknown: [
		"is",
		"is not",
		"contains",
		"does not contain",
		"is empty",
		"is not empty",
	],
};

const FIELD_OPERATORS: Record<string, FilterOperator[]> = {
	file: TYPE_OPERATORS.file,
	"file.name": TYPE_OPERATORS.text,
	"file.basename": TYPE_OPERATORS.text,
	"file.path": TYPE_OPERATORS.text,
	"file.folder": TYPE_OPERATORS.text,
	"file.extension": TYPE_OPERATORS.text,
	"file.ctime": TYPE_OPERATORS.date,
	"file.mtime": TYPE_OPERATORS.date,
	"file.size": TYPE_OPERATORS.number,
	"file links": TYPE_OPERATORS.list,
	"file tags": TYPE_OPERATORS.list,
	aliases: TYPE_OPERATORS.list,
};

const PROPERTY_ICONS: Record<PropertyType, string> = {
	text: "text",
	number: "binary",
	date: "calendar",
	datetime: "clock",
	list: "list",
	checkbox: "check-square",
	file: "file",
	unknown: "text",
};

const ALL_OPERATORS = new Set<FilterOperator>(Object.values(TYPE_OPERATORS).flat());
const WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

export function defaultJournalRules(folder = "Journal"): FilterGroup {
	return {
		type: "group",
		operator: "AND",
		conditions: [
			{
				type: "filter",
				field: "file.folder",
				operator: "is",
				value: normalizeFolderValue(folder) || "Journal",
			},
		],
	};
}

export function firstFolderFromRules(group: FilterGroup): string | null {
	for (const condition of group.conditions) {
		if (condition.type === "group") {
			const nested = firstFolderFromRules(condition);
			if (nested) {
				return nested;
			}
			continue;
		}

		if (
			condition.field === "file"
			&& condition.operator === "in folder"
			&& condition.value?.trim()
		) {
			return normalizeFolderValue(condition.value);
		}
		if (
			condition.field === "file.folder"
			&& (condition.operator === "is" || condition.operator === "starts with")
			&& condition.value?.trim()
		) {
			return normalizeFolderValue(condition.value);
		}
	}
	return null;
}

export function cloneFilterGroup(group: FilterGroup): FilterGroup {
	return JSON.parse(JSON.stringify(group)) as FilterGroup;
}

export function normalizeFilterGroup(value: unknown, fallback: FilterGroup = defaultJournalRules()): FilterGroup {
	const normalized = normalizeCondition(value);
	return normalized?.type === "group" ? normalized : cloneFilterGroup(fallback);
}

export function getOperatorsForField(field: string, type: PropertyType): FilterOperator[] {
	return FIELD_OPERATORS[field] ?? TYPE_OPERATORS[type === "datetime" ? "date" : type] ?? TYPE_OPERATORS.text;
}

export function fieldNeedsValue(operator: FilterOperator): boolean {
	return operator !== "is empty" && operator !== "is not empty";
}

export function getPropertyLabel(key: string): string {
	const labelMap: Record<string, string> = {
		file: "file",
		"file.name": "file name",
		"file.basename": "file title",
		"file.path": "file path",
		"file.folder": "folder",
		"file.extension": "extension",
		"file.size": "file size",
		"file.ctime": "created time",
		"file.mtime": "modified time",
		"file links": "file links",
		"file tags": "file tags",
		aliases: "aliases",
	};
	return labelMap[key] ?? key;
}

export function getPropertyIcon(key: string, type: PropertyType): string {
	if (key === "file links") {
		return "link";
	}
	if (key === "file tags") {
		return "tags";
	}
	if (key === "aliases") {
		return "forward";
	}
	if (key === "file.ctime" || key === "file.mtime") {
		return "clock";
	}
	return PROPERTY_ICONS[type] ?? "pilcrow";
}

export function scanRuleProperties(app: RuleApp): PropertyDef[] {
	const builtInProps: Array<[string, PropertyType]> = [
		["file", "file"],
		["file.name", "text"],
		["file.basename", "text"],
		["file.path", "text"],
		["file.folder", "text"],
		["file.extension", "text"],
		["file.ctime", "date"],
		["file.mtime", "date"],
		["file.size", "number"],
		["file links", "list"],
		["file tags", "list"],
		["aliases", "list"],
	];
	const propMap = new Map<string, PropertyType>(builtInProps);

	for (const file of app.vault?.getMarkdownFiles?.() ?? []) {
		const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
		if (!frontmatter) {
			continue;
		}

		for (const [key, value] of Object.entries(frontmatter)) {
			if (key === "position" || key === "tags" || key === "aliases") {
				continue;
			}
			const assignedType = getObsidianPropertyType(app, key);
			propMap.set(key, assignedType ?? inferPropertyType(value));
		}
	}

	const builtInKeys = new Set(builtInProps.map(([key]) => key));
	const builtIn: PropertyDef[] = [];
	const custom: PropertyDef[] = [];
	for (const [key, type] of propMap.entries()) {
		(builtInKeys.has(key) ? builtIn : custom).push({ key, type });
	}

	builtIn.sort((left, right) => {
		const leftIndex = builtInProps.findIndex(([key]) => key === left.key);
		const rightIndex = builtInProps.findIndex(([key]) => key === right.key);
		return leftIndex - rightIndex;
	});
	custom.sort((left, right) => left.key.localeCompare(right.key));
	return [...builtIn, ...custom];
}

export function inferPropertyType(value: unknown): PropertyType {
	if (value === null || value === undefined) {
		return "unknown";
	}
	if (Array.isArray(value)) {
		return "list";
	}
	if (typeof value === "number") {
		return "number";
	}
	if (typeof value === "boolean") {
		return "checkbox";
	}
	if (typeof value === "string") {
		if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			return "date";
		}
		if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
			return "datetime";
		}
	}
	return "text";
}

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

export function getPropertyType(properties: PropertyDef[], key: string): PropertyType {
	return properties.find((property) => property.key === key)?.type ?? inferFieldType(key);
}

function normalizeCondition(value: unknown): Filter | FilterGroup | null {
	if (!isRecord(value) || typeof value.type !== "string") {
		return null;
	}

	if (value.type === "group") {
		const operator = isConjunction(value.operator) ? value.operator : "AND";
		const conditions = Array.isArray(value.conditions)
			? value.conditions.map(normalizeCondition).filter(isCondition)
			: [];
		return { type: "group", operator, conditions };
	}

	if (value.type === "filter") {
		const field = typeof value.field === "string" && value.field.trim() ? value.field.trim() : "file";
		const type = inferFieldType(field);
		const fallbackOperator = getOperatorsForField(field, type)[0] ?? "is";
		const operator = isFilterOperator(value.operator) ? value.operator : fallbackOperator;
		const filter: Filter = { type: "filter", field, operator };
		if (typeof value.value === "string") {
			filter.value = value.value;
		} else if (typeof value.value === "number" || typeof value.value === "boolean") {
			filter.value = String(value.value);
		}
		return filter;
	}

	return null;
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
		case "does not link to": {
			const targetFile = app.metadataCache.getFirstLinkpathDest?.(filterValue, file.path);
			if (!targetFile) {
				return operator === "does not link to";
			}
			const hasLink = getResolvedOutgoingPaths(app, file, frontmatter).includes(targetFile.path);
			return operator === "links to" ? hasLink : !hasLink;
		}
		case "in folder":
		case "is not in folder": {
			const isInFolder = isFileInFolder(file, filterValue);
			return operator === "in folder" ? isInFolder : !isInFolder;
		}
		case "has tag":
		case "does not have tag": {
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
		case "has property":
		case "does not have property": {
			const propertyName = filterValue.trim();
			if (!propertyName) {
				return operator === "does not have property";
			}
			const hasProperty = Boolean(frontmatter && propertyName in frontmatter);
			return operator === "has property" ? hasProperty : !hasProperty;
		}
		default:
			return false;
	}
}

function valueForField(
	app: RuleApp,
	field: string,
	file: RuleFile,
	frontmatter: FrontmatterRecord | undefined
): FrontmatterValue {
	if (field === "file.name") {
		return file.name;
	}
	if (field === "file.basename") {
		return file.basename;
	}
	if (field === "file.path") {
		return file.path;
	}
	if (field === "file.folder") {
		return file.parent?.path ?? "";
	}
	if (field === "file.extension") {
		return file.extension;
	}
	if (field === "file.size") {
		return file.stat.size;
	}
	if (field === "file.ctime") {
		return file.stat.ctime;
	}
	if (field === "file.mtime") {
		return file.stat.mtime;
	}
	if (field === "file links") {
		return getResolvedOutgoingPaths(app, file, frontmatter).map((path) => path.replace(/\.md$/, ""));
	}
	if (field === "file tags") {
		return getFileTags(app, file, frontmatter);
	}
	if (field === "aliases") {
		const aliases = frontmatter?.aliases;
		return Array.isArray(aliases) ? aliases : aliases ? [aliases] : [];
	}
	return frontmatter?.[field] ?? "";
}

function compareValue(targetValue: FrontmatterValue, operator: FilterOperator, filterValue: string): boolean {
	if (Array.isArray(targetValue)) {
		return compareArray(targetValue, operator, filterValue);
	}

	const scalar = targetValue ?? "";
	const scalarText = String(scalar);
	switch (operator) {
		case "is empty":
			return scalarText.length === 0;
		case "is not empty":
			return scalarText.length > 0;
		case "is":
		case "is exactly":
			return scalarText === filterValue;
		case "is not":
		case "is not exactly":
			return scalarText !== filterValue;
		case "contains":
			return scalarText.includes(filterValue);
		case "does not contain":
			return !scalarText.includes(filterValue);
		case "contains any of":
			return splitValues(filterValue).some((value) => scalarText.includes(value));
		case "does not contain any of":
			return !splitValues(filterValue).some((value) => scalarText.includes(value));
		case "contains all of":
			return splitValues(filterValue).every((value) => scalarText.includes(value));
		case "does not contain all of":
			return !splitValues(filterValue).every((value) => scalarText.includes(value));
		case "starts with":
			return scalarText.startsWith(filterValue);
		case "does not start with":
			return !scalarText.startsWith(filterValue);
		case "ends with":
			return scalarText.endsWith(filterValue);
		case "does not end with":
			return !scalarText.endsWith(filterValue);
		default:
			return false;
	}
}

function compareArray(targetValue: Array<string | number | boolean>, operator: FilterOperator, filterValue: string): boolean {
	const targetStrings = targetValue.map((value) => String(value));
	switch (operator) {
		case "is empty":
			return targetStrings.length === 0;
		case "is not empty":
			return targetStrings.length > 0;
		case "is":
			return targetStrings.includes(filterValue);
		case "is not":
			return !targetStrings.includes(filterValue);
		case "is exactly": {
			const filterValues = splitValues(filterValue);
			return filterValues.length === targetStrings.length
				&& filterValues.every((value) => targetStrings.includes(value));
		}
		case "is not exactly": {
			const filterValues = splitValues(filterValue);
			return filterValues.length !== targetStrings.length
				|| !filterValues.every((value) => targetStrings.includes(value));
		}
		case "contains":
			return targetStrings.some((value) => value.includes(filterValue));
		case "does not contain":
			return !targetStrings.some((value) => value.includes(filterValue));
		case "contains any of":
			return splitValues(filterValue).some((filter) => targetStrings.some((value) => value.includes(filter)));
		case "does not contain any of":
			return !splitValues(filterValue).some((filter) => targetStrings.some((value) => value.includes(filter)));
		case "contains all of":
			return splitValues(filterValue).every((filter) => targetStrings.some((value) => value.includes(filter)));
		case "does not contain all of":
			return !splitValues(filterValue).every((filter) => targetStrings.some((value) => value.includes(filter)));
		default:
			return false;
	}
}

function compareNumber(targetValue: FrontmatterValue, operator: FilterOperator, filterValue: string): boolean {
	if (operator === "is empty" || operator === "is not empty") {
		return compareValue(targetValue, operator, filterValue);
	}
	const target = Number(Array.isArray(targetValue) ? targetValue[0] : targetValue);
	const filter = Number(filterValue);
	if (!Number.isFinite(target) || !Number.isFinite(filter)) {
		return false;
	}

	switch (operator) {
		case "=":
		case "is":
			return target === filter;
		case "!=":
		case "≠":
		case "is not":
			return target !== filter;
		case "<":
			return target < filter;
		case "<=":
		case "≤":
			return target <= filter;
		case ">":
			return target > filter;
		case ">=":
		case "≥":
			return target >= filter;
		default:
			return false;
	}
}

function compareDate(targetValue: FrontmatterValue, operator: FilterOperator, filterValue: string): boolean {
	if (operator === "is empty" || operator === "is not empty") {
		return compareValue(targetValue, operator, filterValue);
	}
	const targetDateString = dateOnlyString(targetValue);
	const filterDateString = filterValue.split("T")[0] ?? "";
	if (!targetDateString || !filterDateString) {
		return false;
	}

	const targetTime = new Date(targetDateString).getTime();
	const filterTime = new Date(filterDateString).getTime();
	if (!Number.isFinite(targetTime) || !Number.isFinite(filterTime)) {
		return false;
	}

	switch (operator) {
		case "on":
			return targetTime === filterTime;
		case "not on":
			return targetTime !== filterTime;
		case "before":
			return targetTime < filterTime;
		case "on or before":
			return targetTime <= filterTime;
		case "after":
			return targetTime > filterTime;
		case "on or after":
			return targetTime >= filterTime;
		default:
			return false;
	}
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

function splitValues(value: string): string[] {
	return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function dateOnlyString(value: FrontmatterValue): string {
	if (typeof value === "number") {
		return new Date(value).toISOString().split("T")[0] ?? "";
	}
	if (typeof value === "string") {
		return value.split("T")[0] ?? "";
	}
	return "";
}

function canCompareDate(value: FrontmatterValue): boolean {
	return typeof value === "number" || typeof value === "string" || value === null || value === undefined;
}

function isDateOperator(operator: FilterOperator): boolean {
	return ["on", "not on", "before", "on or before", "after", "on or after"].includes(operator);
}

function isNumberOperator(operator: FilterOperator): boolean {
	return ["=", "!=", "≠", "<", "<=", "≤", ">", ">=", "≥"].includes(operator);
}

function inferFieldType(field: string): PropertyType {
	if (field === "file") {
		return "file";
	}
	if (field === "file.size") {
		return "number";
	}
	if (field === "file.ctime" || field === "file.mtime") {
		return "date";
	}
	if (field === "file links" || field === "file tags" || field === "aliases") {
		return "list";
	}
	return "text";
}

function getObsidianPropertyType(app: RuleApp, key: string): PropertyType | null {
	const obsidianType = app.metadataTypeManager?.getAssignedType?.(key);
	if (!obsidianType) {
		return null;
	}

	const typeMap: Record<string, PropertyType> = {
		text: "text",
		number: "number",
		date: "date",
		datetime: "datetime",
		checkbox: "checkbox",
		tags: "list",
		aliases: "list",
		multitext: "list",
	};
	return typeMap[obsidianType] ?? null;
}

function normalizeFolderValue(value: string): string {
	return value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isFilterOperator(value: unknown): value is FilterOperator {
	return typeof value === "string" && ALL_OPERATORS.has(value as FilterOperator);
}

function isConjunction(value: unknown): value is FilterConjunction {
	return value === "AND" || value === "OR" || value === "NOR";
}

function isCondition(value: Filter | FilterGroup | null): value is Filter | FilterGroup {
	return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
