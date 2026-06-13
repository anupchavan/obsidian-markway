import { isFilterRecord, parseJsonValue } from "./types";
import type { ParamValidationResult } from './types';

const validObjectParams = ['array', 'keys', 'values'];

export const validateObjectParams = (param: string | undefined): ParamValidationResult => {
	if (!param) {
		return { valid: false, error: 'requires a parameter: "array", "keys", or "values"' };
	}

	if (!validObjectParams.includes(param)) {
		return {
			valid: false,
			error: `invalid parameter "${param}". Use "array", "keys", or "values"`
		};
	}

	return { valid: true };
};

export const object = (str: string, param?: string): string => {
	try {
		const obj = parseJsonValue(str);
		if (isFilterRecord(obj)) {
			switch (param) {
				case 'array':
					return JSON.stringify(Object.entries(obj));
				case 'keys':
					return JSON.stringify(Object.keys(obj));
				case 'values':
					return JSON.stringify(Object.values(obj));
				default:
					return str; // Return original string if no valid param
			}
		}
	} catch (error) {
		console.error('Error parsing JSON for object filter:', error);
	}
	return str;
};
