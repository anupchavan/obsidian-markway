import { getNestedValue, isFilterRecord, isUnknownArray, parseJsonValue, valueToString } from "./types";
import type { ParamValidationResult } from './types';

export const validateTemplateParams = (param: string | undefined): ParamValidationResult => {
	if (!param) {
		return { valid: false, error: 'requires a template string (e.g., template:"${name}")' };
	}

	return { valid: true };
};

export const template = (input: string | unknown[], param?: string): string => {

	if (!param) {
		return typeof input === 'string' ? input : JSON.stringify(input);
	}

	// Remove outer parentheses if present
	param = param.replace(/^\((.*)\)$/, '$1');
	// Remove surrounding quotes (both single and double)
	param = param.replace(/^(['"])([\s\S]*)\1$/, '$2');

	let obj: unknown;
	if (typeof input === 'string') {
		try {
			obj = parseJsonValue(input);
		} catch {
			obj = [input];
		}
	} else {
		obj = input;
	}

	// Ensure obj is always an array
	const objects = isUnknownArray(obj) ? obj : [obj];

	const result = objects.map(item => replaceTemplateVariables(item, param)).join('\n\n');
	return result;
};

function replaceTemplateVariables(obj: unknown, template: string): string {

	// If obj is a plain string, make it available as ${str} for template compatibility
	if (typeof obj === 'string') {
		const strValue = obj;
		obj = parseObjectString(obj);
		// Ensure str property is set for plain strings
		if (isFilterRecord(obj) && obj.str === undefined) {
			obj.str = strValue;
		}
	}

	let result = template.replace(/\$\{([\w.]+)\}/g, (_match: string, path: string) => {
		const value = getNestedValue(obj, path);
		return value !== undefined && value !== 'undefined' ? valueToString(value) : '';
	});

	// Replace \n with actual newlines
	result = result.replace(/\\n/g, '\n');

	// Remove any empty lines (which might be caused by undefined values)
	result = result.split('\n').filter(line => line.trim() !== '').join('\n');

	return result.trim();
}

function parseObjectString(str: string): Record<string, unknown> {
	const obj: Record<string, unknown> = {};
	const regex = /(\w+):\s*("(?:\\.|[^"\\])*"|[^,}]+)/g;
	let match: RegExpExecArray | null;

	while ((match = regex.exec(str)) !== null) {
		const key = match[1];
		let value = match[2];
		if (!key || value === undefined) {
			continue;
		}
		// Remove quotes from the value if it's a string
		if (value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1);
		}
		obj[key] = value === 'undefined' ? undefined : value;
	}

	return obj;
}
