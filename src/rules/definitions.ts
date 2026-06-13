import type { FilterGroup, FilterOperator, PropertyType } from "./types";

export const TYPE_OPERATORS: Record<PropertyType, FilterOperator[]> = {
	text: [
		"is", "is not", "starts with", "ends with", "is empty", "contains",
		"contains any of", "contains all of", "does not start with", "does not end with",
		"is not empty", "does not contain", "does not contain any of", "does not contain all of",
	],
	list: [
		"is exactly", "is not exactly", "is empty", "contains", "contains any of",
		"contains all of", "is not empty", "does not contain", "does not contain any of",
		"does not contain all of",
	],
	number: ["=", "!=", "<", "<=", ">", ">=", "is empty", "is not empty"],
	date: ["on", "not on", "before", "on or before", "after", "on or after", "is empty", "is not empty"],
	datetime: ["on", "not on", "before", "on or before", "after", "on or after", "is empty", "is not empty"],
	checkbox: ["is", "is not", "is empty", "is not empty"],
	file: [
		"links to", "in folder", "has tag", "has property", "does not link to",
		"is not in folder", "does not have tag", "does not have property",
	],
	unknown: ["is", "is not", "contains", "does not contain", "is empty", "is not empty"],
};

export const FIELD_OPERATORS: Record<string, FilterOperator[]> = {
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

export const ALL_OPERATORS = new Set<FilterOperator>(Object.values(TYPE_OPERATORS).flat());

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

export function defaultJournalRules(folder = "Journal"): FilterGroup {
	return {
		type: "group",
		operator: "AND",
		conditions: [{
			type: "filter",
			field: "file.folder",
			operator: "is",
			value: normalizeFolderValue(folder) || "Journal",
		}],
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
		if (condition.field === "file" && condition.operator === "in folder" && condition.value?.trim()) {
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

export function inferFieldType(field: string): PropertyType {
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

export function normalizeFolderValue(value: string): string {
	return value
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "")
		.split("/")
		.map((part) => part.trim())
		.filter((part) => part && part !== "." && part !== "..")
		.join("/");
}
