import { isFilterRecord, parseJsonValue } from "./types";

export const reverse = (str: string): string => {
	// Return early if input is empty or invalid
	if (!str || str === 'undefined' || str === 'null') {
		return '';
	}

	try {
		const value = parseJsonValue(str);
		if (Array.isArray(value)) {
			// Handle arrays
			return JSON.stringify(value.reverse());
		} else if (isFilterRecord(value)) {
			// Handle objects by reversing key-value pairs
			const entries = Object.entries(value);
			const reversedEntries = entries.reverse();
			const reversedObject = Object.fromEntries(reversedEntries);
			return JSON.stringify(reversedObject);
		}
	} catch {
		// If not valid JSON, treat as string
		return str.split('').reverse().join('');
	}

	return str;
};
