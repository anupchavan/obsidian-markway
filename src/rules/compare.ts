import type { FilterOperator, FrontmatterValue } from "./types";

export function compareValue(targetValue: FrontmatterValue, operator: FilterOperator, filterValue: string): boolean {
	if (Array.isArray(targetValue)) {
		return compareArray(targetValue, operator, filterValue);
	}

	const scalar = targetValue ?? "";
	const scalarText = String(scalar);
	switch (operator) {
		case "is empty": return scalarText.length === 0;
		case "is not empty": return scalarText.length > 0;
		case "is":
		case "is exactly": return scalarText === filterValue;
		case "is not":
		case "is not exactly": return scalarText !== filterValue;
		case "contains": return scalarText.includes(filterValue);
		case "does not contain": return !scalarText.includes(filterValue);
		case "contains any of": return splitValues(filterValue).some((value) => scalarText.includes(value));
		case "does not contain any of": return !splitValues(filterValue).some((value) => scalarText.includes(value));
		case "contains all of": return splitValues(filterValue).every((value) => scalarText.includes(value));
		case "does not contain all of": return !splitValues(filterValue).every((value) => scalarText.includes(value));
		case "starts with": return scalarText.startsWith(filterValue);
		case "does not start with": return !scalarText.startsWith(filterValue);
		case "ends with": return scalarText.endsWith(filterValue);
		case "does not end with": return !scalarText.endsWith(filterValue);
		default: return false;
	}
}

export function compareNumber(targetValue: FrontmatterValue, operator: FilterOperator, filterValue: string): boolean {
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
		case "is": return target === filter;
		case "!=":
		case "≠":
		case "is not": return target !== filter;
		case "<": return target < filter;
		case "<=":
		case "≤": return target <= filter;
		case ">": return target > filter;
		case ">=":
		case "≥": return target >= filter;
		default: return false;
	}
}

export function compareDate(targetValue: FrontmatterValue, operator: FilterOperator, filterValue: string): boolean {
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
		case "on": return targetTime === filterTime;
		case "not on": return targetTime !== filterTime;
		case "before": return targetTime < filterTime;
		case "on or before": return targetTime <= filterTime;
		case "after": return targetTime > filterTime;
		case "on or after": return targetTime >= filterTime;
		default: return false;
	}
}

export function canCompareDate(value: FrontmatterValue): boolean {
	return typeof value === "number" || typeof value === "string" || value === null || value === undefined;
}

export function isDateOperator(operator: FilterOperator): boolean {
	return ["on", "not on", "before", "on or before", "after", "on or after"].includes(operator);
}

export function isNumberOperator(operator: FilterOperator): boolean {
	return ["=", "!=", "≠", "<", "<=", "≤", ">", ">=", "≥"].includes(operator);
}

export function splitValues(value: string): string[] {
	return value.split(",").map((part) => part.trim()).filter(Boolean);
}

function compareArray(targetValue: Array<string | number | boolean>, operator: FilterOperator, filterValue: string): boolean {
	const targetStrings = targetValue.map((value) => String(value));
	switch (operator) {
		case "is empty": return targetStrings.length === 0;
		case "is not empty": return targetStrings.length > 0;
		case "is": return targetStrings.includes(filterValue);
		case "is not": return !targetStrings.includes(filterValue);
		case "is exactly": return exactlyMatches(targetStrings, filterValue);
		case "is not exactly": return !exactlyMatches(targetStrings, filterValue);
		case "contains": return targetStrings.some((value) => value.includes(filterValue));
		case "does not contain": return !targetStrings.some((value) => value.includes(filterValue));
		case "contains any of": return splitValues(filterValue).some((filter) => targetStrings.some((value) => value.includes(filter)));
		case "does not contain any of": return !splitValues(filterValue).some((filter) => targetStrings.some((value) => value.includes(filter)));
		case "contains all of": return splitValues(filterValue).every((filter) => targetStrings.some((value) => value.includes(filter)));
		case "does not contain all of": return !splitValues(filterValue).every((filter) => targetStrings.some((value) => value.includes(filter)));
		default: return false;
	}
}

function exactlyMatches(targetStrings: string[], filterValue: string): boolean {
	const filterValues = splitValues(filterValue);
	return filterValues.length === targetStrings.length
		&& filterValues.every((value) => targetStrings.includes(value));
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
