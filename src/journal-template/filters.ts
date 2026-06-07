import { sanitizeFileName } from "../sync-utils";
import { splitTopLevel, stripParamWrapper, stripQuotes } from "./parser";

export type FilterFunction = (input: string, param?: string) => string;

export const FILTERS: Record<string, FilterFunction> = {
	capitalize: filterCapitalize,
	date: filterDate,
	first: filterFirst,
	join: filterJoin,
	last: filterLast,
	length: filterLength,
	lower: (input) => input.toLocaleLowerCase(),
	map: filterMap,
	replace: filterReplace,
	safe_name: sanitizeFileName,
	title: filterTitle,
	trim: (input) => input.trim(),
	unique: filterUnique,
	upper: (input) => input.toLocaleUpperCase(),
	wikilink: filterWikilink,
};

function filterMap(input: string, param?: string): string {
	const match = param?.match(/^\s*(\w+)\s*=>\s*(.+)$/);
	if (!match) {
		return input;
	}

	const [, argName, expression] = match;
	const array = parseArrayInput(input);
	const mapped = array.map((item) => evaluateMapExpression(expression ?? "", item, argName ?? "item"));
	return JSON.stringify(mapped);
}

function filterDate(input: string, param?: string): string {
	const date = new Date(input);
	if (Number.isNaN(date.getTime())) {
		return input;
	}

	const format = stripQuotes(stripParamWrapper(param || "YYYY-MM-DD")) || "YYYY-MM-DD";
	const values: Record<string, string> = {
		YYYY: String(date.getFullYear()).padStart(4, "0"),
		YY: String(date.getFullYear()).slice(-2),
		MM: String(date.getMonth() + 1).padStart(2, "0"),
		M: String(date.getMonth() + 1),
		DD: String(date.getDate()).padStart(2, "0"),
		D: String(date.getDate()),
		HH: String(date.getHours()).padStart(2, "0"),
		H: String(date.getHours()),
		mm: String(date.getMinutes()).padStart(2, "0"),
		m: String(date.getMinutes()),
		ss: String(date.getSeconds()).padStart(2, "0"),
		s: String(date.getSeconds()),
	};

	return format.replace(/YYYY|YY|MM|M|DD|D|HH|H|mm|m|ss|s/g, (token) => values[token] ?? token);
}

function evaluateMapExpression(expression: string, item: unknown, argName: string): unknown {
	const expr = expression.trim().replace(/^\(([\s\S]*)\)$/, "$1").trim();
	if ((expr.startsWith("\"") && expr.endsWith("\"")) || (expr.startsWith("'") && expr.endsWith("'"))) {
		const literal = stripQuotes(expr);
		return literal.replace(new RegExp(`\\$\\{${argName}\\}`, "g"), String(item));
	}
	if (expr.startsWith("{") && expr.endsWith("}")) {
		return evaluateMapObject(expr, item, argName);
	}

	const pathPrefix = `${argName}.`;
	if (expr.startsWith(pathPrefix)) {
		return readPath(item, expr.slice(pathPrefix.length));
	}
	return expr;
}

function evaluateMapObject(expr: string, item: unknown, argName: string): Record<string, unknown> {
	const object: Record<string, unknown> = {};
	for (const assignment of splitTopLevel(expr.slice(1, -1), ",")) {
		const [rawKey, rawValue] = splitTopLevel(assignment, ":");
		const key = stripQuotes(rawKey ?? "").trim();
		if (key) {
			object[key] = evaluateMapExpression(rawValue ?? "", item, argName);
		}
	}
	return object;
}

function parseArrayInput(input: string): unknown[] {
	try {
		const parsed = JSON.parse(input) as unknown;
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch {
		return [input];
	}
}

function readPath(value: unknown, path: string): unknown {
	const parts = path.replace(/\[([^\]]+)\]/g, ".$1").split(".").filter(Boolean);
	return parts.reduce<unknown>((current, key) => {
		if (current && typeof current === "object") {
			return (current as Record<string, unknown>)[key];
		}
		return undefined;
	}, value);
}

function filterReplace(input: string, param?: string): string {
	if (!param) {
		return input;
	}

	return splitTopLevel(stripParamWrapper(param), ",").reduce((current, replacement) => {
		const separatorIndex = replacement.search(/:\s*(['"]|$)/);
		if (separatorIndex === -1) {
			return current;
		}
		const search = stripQuotes(replacement.slice(0, separatorIndex));
		const replaceWith = processEscapes(stripQuotes(replacement.slice(separatorIndex + 1)));
		const regex = parseRegexLiteral(search);
		return regex
			? current.replace(regex, replaceWith)
			: current.split(processEscapes(search)).join(replaceWith);
	}, input);
}

function parseRegexLiteral(value: string): RegExp | null {
	const match = value.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
	if (!match) {
		return null;
	}
	try {
		return new RegExp(match[1] ?? "", match[2] ?? "");
	} catch {
		return null;
	}
}

function processEscapes(value: string): string {
	return value.replace(/\\([nrt]|[^nrt])/g, (_match, character: string) => {
		switch (character) {
			case "n": return "\n";
			case "r": return "\r";
			case "t": return "\t";
			default: return character;
		}
	});
}

function filterWikilink(input: string, param?: string): string {
	const alias = param ? stripQuotes(stripParamWrapper(param)) : "";
	try {
		const parsed = JSON.parse(input) as unknown;
		if (Array.isArray(parsed)) {
			return JSON.stringify(parsed.map((item) => wikilinkValue(String(item), alias)));
		}
		if (parsed && typeof parsed === "object") {
			return JSON.stringify(Object.entries(parsed).map(([page, value]) => wikilinkValue(page, String(value))));
		}
	} catch {
		return wikilinkValue(input, alias);
	}
	return input;
}

function wikilinkValue(page: string, alias: string): string {
	const trimmed = page.trim();
	if (!trimmed) {
		return "";
	}
	return alias ? `[[${trimmed}|${alias}]]` : `[[${trimmed}]]`;
}

function filterJoin(input: string, param?: string): string {
	const separator = param ? processEscapes(stripQuotes(stripParamWrapper(param))) : ",";
	try {
		const parsed = JSON.parse(input) as unknown;
		return Array.isArray(parsed) ? parsed.join(separator) : input;
	} catch {
		return input;
	}
}

function filterUnique(input: string): string {
	try {
		const parsed = JSON.parse(input) as unknown;
		if (!Array.isArray(parsed)) {
			return input;
		}
		const items = [...new Set(parsed.map((item) => JSON.stringify(item)))];
		return JSON.stringify(items.map((item) => JSON.parse(item) as unknown));
	} catch {
		return input;
	}
}

function filterFirst(input: string): string {
	const array = parseArrayInput(input);
	return array.length > 0 ? String(array[0]) : input;
}

function filterLast(input: string): string {
	const array = parseArrayInput(input);
	return array.length > 0 ? String(array[array.length - 1]) : input;
}

function filterLength(input: string): string {
	try {
		const parsed = JSON.parse(input) as unknown;
		if (Array.isArray(parsed)) {
			return String(parsed.length);
		}
		if (parsed && typeof parsed === "object") {
			return String(Object.keys(parsed).length);
		}
	} catch {
		// Fall through to string length.
	}
	return String(input.length);
}

function filterCapitalize(input: string): string {
	return input.charAt(0).toLocaleUpperCase() + input.slice(1).toLocaleLowerCase();
}

function filterTitle(input: string): string {
	const smallWords = new Set(["a", "an", "the", "and", "but", "or", "for", "nor", "on", "at", "to", "from", "by", "in", "of"]);
	return input.split(/\s+/g).map((word, index) => {
		if (index > 0 && smallWords.has(word.toLocaleLowerCase())) {
			return word.toLocaleLowerCase();
		}
		return filterCapitalize(word);
	}).join(" ");
}
