import { isFilterRecord, parseJsonOr, parseJsonValue, valueToString } from "./types";
import type { ParamValidationResult } from './types';

export const validateMapParams = (param: string | undefined): ParamValidationResult => {
	if (!param) {
		return { valid: false, error: 'requires an arrow function (e.g., map:x => x.name)' };
	}

	const match = param.match(/^\s*(\w+)\s*=>\s*(.+)$/);
	if (!match) {
		return { valid: false, error: 'invalid syntax. Use arrow function format (e.g., x => x.name)' };
	}

	return { valid: true };
};

export const map = (str: string, param?: string): string => {

	const array = parseJsonOr(str, [str]);

	if (Array.isArray(array) && param) {
		const match = param.match(/^\s*(\w+)\s*=>\s*(.+)$/);
		if (!match) {
			return str;
		}
		const argName = match[1];
		const expression = match[2];
		if (!argName || !expression) {
			return str;
		}

		const mappedArray = array.map((item) => {
			// Strip outer parentheses for object literal syntax: ({key: value})
			let expr = expression.trim();
			if (expr.startsWith('(') && expr.endsWith(')')) {
				expr = expr.slice(1, -1).trim();
			}

			// Check if the expression is an object literal or a string literal
			if ((expr.startsWith('{') && expr.endsWith('}')) ||
				(expr.startsWith('"') && expr.endsWith('"')) ||
				(expr.startsWith("'") && expr.endsWith("'"))) {
				// Use a simple object to store the mapped properties
				const mappedItem: Record<string, unknown> = {};

				// Parse the expression to extract property assignments or string literal
				if (expr.startsWith('{')) {
					const assignmentSource = expr.match(/\{(.+)\}/)?.[1] ?? "";
					const assignments = assignmentSource ? assignmentSource.split(',') : [];

					assignments.forEach((assignment) => {
						const [key, value] = assignment.split(':').map(s => s.trim());
						if (!key || value === undefined) {
							return;
						}
						// Remove any surrounding quotes from the key
						const cleanKey = key.replace(/^['"](.+)['"]$/, '$1');
						// Evaluate the value expression
						const cleanValue = evaluateExpression(value, item, argName);
						mappedItem[cleanKey] = cleanValue;
					});
				} else {
					// Handle string literal — return plain string
					const stringLiteral = expr.slice(1, -1);
					return stringLiteral.replace(new RegExp(`\\$\\{${escapeRegExp(argName)}\\}`, 'g'), valueToString(item));
				}
				return mappedItem;
				} else {
					// If it's not an object literal or string literal, treat it as a simple expression
					return evaluateExpression(expression, item, argName);
				}
			});
		return JSON.stringify(mappedArray);
	}
	return str;
};

function evaluateExpression(expression: string, item: unknown, argName: string): unknown {
	if (typeof item === 'string') {
		// For simple string arrays, return the item directly
		return item;
	}
	const result = expression.replace(new RegExp(`${escapeRegExp(argName)}\\.([\\w.[\\]]+)`, 'g'), (_match: string, prop: string) => {
		const value = getNestedProperty(item, prop);
		return JSON.stringify(value);
	});
	try {
		return parseJsonValue(result);
	} catch {
		return result.replace(/^["'](.+)["']$/, '$1');
	}
}

function getNestedProperty(obj: unknown, path: string): unknown {
	let current: unknown = obj;
	for (const key of path.replace(/\[/g, ".").replace(/\]/g, "").split(".").filter(Boolean)) {
		if (Array.isArray(current) && /^\d+$/.test(key)) {
			current = current[parseInt(key, 10)];
			continue;
		}
		if (isFilterRecord(current)) {
			current = current[key];
			continue;
		}
		return undefined;
	}
	return current;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
