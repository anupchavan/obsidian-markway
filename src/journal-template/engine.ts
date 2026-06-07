import { FILTERS } from "./filters";
import { parseFilterExpression, splitPipeline } from "./parser";
import type { TemplateContext } from "./context";

export const JOURNAL_TEMPLATE_VARIABLES = new Set([
	"id",
	"uuid",
	"title",
	"content",
	"body",
	"created",
	"modified",
	"updated",
	"date",
	"time",
	"music",
]);

export function validateTemplateVariables(template: string): string[] {
	const unknown = new Set<string>();
	for (const expression of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
		const [variable] = splitPipeline(expression[1] ?? "");
		const variableName = variable?.trim().split(":")[0]?.trim();
		if (variableName && !JOURNAL_TEMPLATE_VARIABLES.has(variableName)) {
			unknown.add(variableName);
		}
	}
	return [...unknown].map((variable) => `Unknown variable "${variable}"`);
}

export function renderTemplate(template: string, context: TemplateContext): { value: string; errors: string[] } {
	const errors: string[] = [];
	const value = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawExpression: string) => {
		const evaluated = evaluateExpression(rawExpression, context);
		errors.push(...evaluated.errors);
		return evaluated.value;
	});
	return { value, errors };
}

function evaluateExpression(expression: string, context: TemplateContext): { value: string; errors: string[] } {
	const parts = splitPipeline(expression);
	const variableExpression = parts.shift()?.trim() ?? "";
	const variableName = variableExpression.split(":")[0]?.trim() ?? "";
	const errors: string[] = [];

	if (!JOURNAL_TEMPLATE_VARIABLES.has(variableName)) {
		return { value: "", errors: [`Unknown variable "${variableName}"`] };
	}

	let value = stringifyTemplateValue(context[variableName]);
	for (const filterExpression of parts) {
		const parsed = parseFilterExpression(filterExpression);
		const filter = FILTERS[parsed.name];
		if (!filter) {
			errors.push(`Unknown filter "${parsed.name}"`);
			continue;
		}
		value = filter(value, parsed.param);
	}
	return { value, errors };
}

function stringifyTemplateValue(value: unknown): string {
	if (value === undefined || value === null) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(value);
}
