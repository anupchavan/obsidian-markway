import { isFilterRecord, parseJsonValue, valueToString } from "./types";
import { escapeMarkdown } from './string-utils';

export const link = (str: string, param?: string): string => {
	if (!str.trim()) {
		return str;
	}

	let linkText = 'link';
	if (param) {
		// Remove outer parentheses if present
		param = param.replace(/^\((.*)\)$/, '$1');
		// Remove surrounding quotes (both single and double)
		linkText = param.replace(/^(['"])([\s\S]*)\1$/, '$2');
	}

	const encodeUrl = (url: string): string => {
		return url.replace(/ /g, '%20');
	};

	try {
		const data = parseJsonValue(str);
		
		const processObject = (obj: Record<string, unknown>): string[] => {
			return Object.entries(obj).map(([key, value]) => {
				if (isFilterRecord(value)) {
					return processObject(value);
				}
				return `[${escapeMarkdown(valueToString(value))}](${encodeUrl(escapeMarkdown(key))})`;
			}).flat();
		};

		if (Array.isArray(data)) {
			const result = data.map(item => {
				if (isFilterRecord(item)) {
					return processObject(item);
				}
				return item ? `[${linkText}](${encodeUrl(escapeMarkdown(valueToString(item)))})` : '';
			});
			return result.join('\n');
		} else if (isFilterRecord(data)) {
			return processObject(data).join('\n');
		}
	} catch {
		// If parsing fails, treat it as a single URL string
		return `[${linkText}](${encodeUrl(escapeMarkdown(str))})`;
	}

	return str;
};
