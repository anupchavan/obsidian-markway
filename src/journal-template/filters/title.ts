import { isFilterRecord, parseJsonValue } from "./types";

// TODO: Consider implementing multi-language support for title casing
// Current implementation is English-specific
const lowercaseWords = ['a', 'an', 'the', 'and', 'but', 'or', 'for', 'nor', 'on', 'at', 'to', 'from', 'by', 'in', 'of'];

export const title = (input: string | string[], param?: string): string | string[] => {
	const toTitleCase = (str: string): string => {
		return str.split(/\s+/).map((word, index) => {
			if (index !== 0 && lowercaseWords.includes(word.toLowerCase())) {
				return word.toLowerCase();
			}
			return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
		}).join(' ');
	};

	const processValue = (value: unknown): unknown => {
		if (typeof value === 'string') {
			return toTitleCase(value);
		} else if (Array.isArray(value)) {
			return value.map(processValue);
		} else if (isFilterRecord(value)) {
			const result: Record<string, unknown> = {};
			for (const [key, val] of Object.entries(value)) {
				result[toTitleCase(key)] = processValue(val);
			}
			return result;
		}
		return value;
	};

	try {
		const parsedInput = parseJsonValue(Array.isArray(input) ? JSON.stringify(input) : input);
		const result = processValue(parsedInput);
		return JSON.stringify(result);
	} catch {
		// If parsing fails, treat it as a single string or array of strings
		const result = processValue(input);
		return typeof result === "string" || Array.isArray(result) ? result : JSON.stringify(result);
	}
};
