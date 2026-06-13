import { isFilterRecord, parseJsonValue, valueToString } from "./types";

export const wikilink = (str: string, param?: string): string => {
	if (!str.trim()) {
		return str;
	}

	let alias = '';
	if (param) {
		// Remove outer parentheses if present
		param = param.replace(/^\((.*)\)$/, '$1');
		// Remove surrounding quotes (both single and double)
		alias = param.replace(/^(['"])([\s\S]*)\1$/, '$2');
	}

	try {
		const data = parseJsonValue(str);
		
		const processObject = (obj: Record<string, unknown>): string[] => {
			return Object.entries(obj).map(([key, value]) => {
				if (isFilterRecord(value)) {
					return processObject(value);
				}
				return `[[${key}|${valueToString(value)}]]`;
			}).flat();
		};

		if (Array.isArray(data)) {
			const result = data.flatMap(item => {
				if (isFilterRecord(item)) {
					return processObject(item);
				}
				const page = valueToString(item);
				return page ? (alias ? `[[${page}|${alias}]]` : `[[${page}]]`) : '';
			});
			return JSON.stringify(result);
		} else if (isFilterRecord(data)) {
			return JSON.stringify(processObject(data));
		}
	} catch {
		// If parsing fails, treat it as a single string
		return alias ? `[[${str}|${alias}]]` : `[[${str}]]`;
	}
	return str;
};
