import { isFilterRecord, parseJsonValue } from "./types";

export const capitalize = (input: string): string => {
	const capitalizeString = (str: string): string => 
		str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();

	try {
		const parseAndCapitalize = (value: unknown): unknown => {
			if (typeof value === 'string') {
				return capitalizeString(value);
			} else if (Array.isArray(value)) {
				return value.map(parseAndCapitalize);
			} else if (isFilterRecord(value)) {
				const result: Record<string, unknown> = {};
				for (const [key, val] of Object.entries(value)) {
					result[capitalizeString(key)] = parseAndCapitalize(val);
				}
				return result;
			}
			return value;
		};

		const parsed = parseJsonValue(input);
		const capitalized = parseAndCapitalize(parsed);
		return JSON.stringify(capitalized);
	} catch {
		// If parsing fails, treat the input as a simple string
		return capitalizeString(input);
	}
};
