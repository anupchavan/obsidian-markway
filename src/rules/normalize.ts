import { ALL_OPERATORS, cloneFilterGroup, defaultJournalRules, getOperatorsForField, inferFieldType } from "./definitions";
import type { Filter, FilterConjunction, FilterGroup, FilterOperator } from "./types";

export function normalizeFilterGroup(value: unknown, fallback: FilterGroup = defaultJournalRules()): FilterGroup {
	const normalized = normalizeCondition(value);
	return normalized?.type === "group" ? normalized : cloneFilterGroup(fallback);
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
