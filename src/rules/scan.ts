import { inferFieldType } from "./definitions";
import type { PropertyDef, PropertyType, RuleApp } from "./types";

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

export function scanRuleProperties(app: RuleApp): PropertyDef[] {
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
	return sortProperties(propMap);
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

export function getPropertyType(properties: PropertyDef[], key: string): PropertyType {
	return properties.find((property) => property.key === key)?.type ?? inferFieldType(key);
}

function sortProperties(propMap: Map<string, PropertyType>): PropertyDef[] {
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
