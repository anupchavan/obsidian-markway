import { isFilterRecord, parseJsonValue, valueToString } from "./types";
import { escapeMarkdown } from './string-utils';

export const image = (str: string, param?: string): string | string[] => {
	if (!str.trim()) {
		return str;
	}

	let altText = '';
	if (param) {
		// Remove outer parentheses if present
		param = param.replace(/^\((.*)\)$/, '$1');
		// Remove surrounding quotes (both single and double)
		altText = param.replace(/^(['"])([\s\S]*)\1$/, '$2');
	}

	try {
		const data = parseJsonValue(str);
		
		const processObject = (obj: Record<string, unknown>): string[] => {
			return Object.entries(obj).map(([key, value]) => {
				if (isFilterRecord(value)) {
					return processObject(value);
				}
				return `![${escapeMarkdown(valueToString(value))}](${escapeMarkdown(key)})`;
			}).flat();
		};

		if (Array.isArray(data)) {
			return data.map(item => {
				if (isFilterRecord(item)) {
					return processObject(item);
				}
				return item ? `![${altText}](${escapeMarkdown(valueToString(item))})` : '';
			}).flat();
		} else if (isFilterRecord(data)) {
			return processObject(data);
		}
	} catch {
		// If parsing fails, treat it as a single URL string
		return `![${altText}](${escapeMarkdown(str)})`;
	}

	return str;
};
