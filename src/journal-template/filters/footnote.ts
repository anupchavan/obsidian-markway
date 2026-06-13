import { isFilterRecord, parseJsonValue, valueToString } from "./types";

export const footnote = (str: string): string => {
	// Return empty string as-is without attempting to parse
	if (str === '') {
		return str;
	}

	try {
		const data = parseJsonValue(str);
		if (Array.isArray(data)) {
			return data.map((item, index) => `[^${index + 1}]: ${valueToString(item)}`).join('\n\n');
		} else if (isFilterRecord(data)) {
			return Object.entries(data).map(([key, value]) => {
				const footnoteId = key.replace(/([a-z])([A-Z])/g, '$1-$2')
					.replace(/[\s_]+/g, '-')
					.toLowerCase();
				return `[^${footnoteId}]: ${valueToString(value)}`;
			}).join('\n\n');
		}
	} catch (error) {
		console.error('Error parsing JSON in footnote filter:', error);
	}
	return str;
};
