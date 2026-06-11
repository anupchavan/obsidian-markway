import { FILTERS } from "./filters";
import { parseFilterExpression, splitPipeline } from "./parser";
import { ENTRY_TEMPLATE_KEYS, type TemplateContext } from "./context";

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
	"photos",
	"attachments",
	"entry",
]);

export function validateTemplateVariables(template: string): string[] {
	const unknown = new Set<string>();
	for (const variableName of templateVariableNames(template)) {
		const message = unknownVariableMessage(variableName);
		if (message) {
			unknown.add(message);
		}
	}
	return [...unknown];
}

export function templateVariableNames(template: string): string[] {
	const names: string[] = [];
	for (const expression of template.matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)) {
		const [variable] = splitPipeline(expression[1] ?? "");
		const variableName = variable?.trim().split(":")[0]?.trim();
		if (variableName) {
			names.push(variableName);
		}
	}
	return names;
}

export function renderTemplate(template: string, context: TemplateContext): { value: string; errors: string[] } {
	const errors: string[] = [];
	const value = template.replace(/\{\{\s*([\s\S]*?)\s*\}\}/g, (_match, rawExpression: string) => {
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

	const unknownMessage = unknownVariableMessage(variableName);
	if (unknownMessage) {
		return { value: "", errors: [unknownMessage] };
	}

	let value = stringifyTemplateValue(resolveVariablePath(variableName, context));
	for (const filterExpression of parts) {
		const parsed = parseFilterExpression(filterExpression);
		const filter = FILTERS[parsed.name];
		if (!filter) {
			errors.push(`Unknown filter "${parsed.name}"`);
			continue;
		}
		// Clipper filters may return arrays; its dispatcher stringifies between
		// pipeline steps, so do the same here.
		const output = filter(value, parsed.param);
		value = typeof output === "string" ? output : JSON.stringify(output);
	}
	return { value, errors };
}

function unknownVariableMessage(variableName: string): string | null {
	const segments = variableName.split(".");
	const rootName = segments[0]?.trim() ?? "";
	if (!JOURNAL_TEMPLATE_VARIABLES.has(rootName)) {
		return `Unknown variable "${variableName}"`;
	}
	if (rootName === "entry" && segments.length > 1 && !ENTRY_TEMPLATE_KEYS.has(segments[1] ?? "")) {
		return `Unknown variable "${variableName}"`;
	}
	return null;
}

function resolveVariablePath(variableName: string, context: TemplateContext): unknown {
	const segments = variableName.split(".");
	let value: unknown = context[segments[0] ?? ""];
	for (const segment of segments.slice(1)) {
		if (value === null || value === undefined || typeof value !== "object") {
			return undefined;
		}
		value = (value as Record<string, unknown>)[segment];
	}
	return value;
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
