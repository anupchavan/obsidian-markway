// Mirrors the filter contract from obsidian-clipper src/types/types.ts @ 372d420.
// Filters may return arrays; the template engine stringifies between pipeline
// steps the same way the clipper dispatcher does.
export type FilterFunction = (value: string, param?: string) => string | unknown[];

export interface ParamValidationResult {
	valid: boolean;
	error?: string;
}

export type FilterRecord = Record<string, unknown>;

export function isFilterRecord(value: unknown): value is FilterRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isUnknownArray(value: unknown): value is unknown[] {
	return Array.isArray(value);
}

export function parseJsonValue(value: string): unknown {
	return JSON.parse(value) as unknown;
}

export function parseJsonOr(value: string, fallback: unknown): unknown {
	try {
		return parseJsonValue(value);
	} catch {
		return fallback;
	}
}

export function stringifyFilterValue(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

export function valueToString(value: unknown): string {
	switch (typeof value) {
		case "string":
			return value;
		case "number":
		case "boolean":
		case "bigint":
			return value.toString();
		case "symbol":
			return value.description ?? "";
		case "object":
			return value === null ? "" : JSON.stringify(value) ?? "";
		default:
			return "";
	}
}

export function getNestedValue(value: unknown, path: string): unknown {
	let current: unknown = value;
	for (const key of path.split(".")) {
		if (isFilterRecord(current)) {
			current = current[key];
			continue;
		}
		if (Array.isArray(current) && /^\d+$/.test(key)) {
			current = current[Number(key)];
			continue;
		}
		return undefined;
	}
	return current;
}
