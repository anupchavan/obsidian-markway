import {
	sha256Hex,
	type JournalEntryText,
	type JournalMusicAttachment,
	type MarkwaySettings,
} from "./sync-utils";

export interface TemplateRenderResult {
	properties: Record<string, unknown>;
	hash: string;
	errors: TemplateValidationError[];
}

export interface TemplateValidationError {
	propertyID: string;
	message: string;
}

export const JOURNAL_TEMPLATE_VARIABLES = new Set([
	"id",
	"uuid",
	"title",
	"content",
	"body",
	"created",
	"modified",
	"updated",
	"date",
	"time",
	"music",
]);

type TemplateContext = Record<string, unknown>;

type FilterFunction = (input: string, param?: string) => string;

const FILTERS: Record<string, FilterFunction> = {
	capitalize: filterCapitalize,
	date: filterDate,
	first: filterFirst,
	join: filterJoin,
	last: filterLast,
	length: filterLength,
	lower: (input) => input.toLocaleLowerCase(),
	map: filterMap,
	replace: filterReplace,
	safe_name: filterSafeName,
	title: filterTitle,
	trim: (input) => input.trim(),
	unique: filterUnique,
	upper: (input) => input.toLocaleUpperCase(),
	wikilink: filterWikilink,
};

export function journalTemplateNeedsMusic(settings: MarkwaySettings): boolean {
	return settings.journalProperties.some((property) => property.key.trim() && property.value.includes("{{music"));
}

export function journalTemplateSettingsHash(settings: MarkwaySettings): string {
	return sha256Hex(JSON.stringify({
		properties: settings.journalProperties,
		includeTitleHeading: settings.journalIncludeTitleHeading,
	}));
}

export function renderJournalTemplateProperties(
	entry: JournalEntryText,
	settings: MarkwaySettings,
	now = new Date()
): TemplateRenderResult {
	const context = journalTemplateContext(entry, now);
	const properties: Record<string, unknown> = {};
	const errors: TemplateValidationError[] = [];

	for (const property of settings.journalProperties) {
		const key = property.key.trim();
		if (!key) {
			continue;
		}

		const rendered = renderTemplate(property.value, context);
		if (rendered.errors.length > 0) {
			errors.push(...rendered.errors.map((message) => ({ propertyID: property.id, message })));
		}
		properties[key] = coerceFrontmatterValue(rendered.value);
	}

	const settingsHash = journalTemplateSettingsHash(settings);
	const hash = sha256Hex(JSON.stringify({ settingsHash, properties }));
	return { properties, hash, errors };
}

export function renderJournalBody(entry: JournalEntryText, includeTitleHeading: boolean): string {
	if (!includeTitleHeading || !entry.title.trim()) {
		return entry.body;
	}
	return `# ${entry.title.trim()}\n\n${entry.body}`;
}

export function stripGeneratedTitleHeading(body: string, title: string): string {
	const heading = `# ${title.trim()}`;
	if (!title.trim()) {
		return body;
	}

	const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (normalized === heading) {
		return "";
	}
	if (!normalized.startsWith(`${heading}\n`)) {
		return body;
	}

	if (normalized.startsWith(`${heading}\n\n`)) {
		return normalized.slice(heading.length + 2);
	}
	return normalized.slice(heading.length + 1);
}

export function validateTemplateVariables(template: string): string[] {
	const unknown = new Set<string>();
	for (const expression of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
		const [variable] = splitPipeline(expression[1] ?? "");
		const variableName = variable?.trim().split(":")[0]?.trim();
		if (variableName && !JOURNAL_TEMPLATE_VARIABLES.has(variableName)) {
			unknown.add(variableName);
		}
	}
	return [...unknown].map((variable) => `Unknown variable "${variable}"`);
}

function renderTemplate(template: string, context: TemplateContext): { value: string; errors: string[] } {
	const errors: string[] = [];
	const value = template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawExpression: string) => {
		const evaluated = evaluateExpression(rawExpression, context);
		errors.push(...evaluated.errors);
		return evaluated.value;
	});
	return { value, errors };
}

function evaluateExpression(expression: string, context: TemplateContext): { value: string; errors: string[] } {
	const parts = splitPipeline(expression);
	const variableExpression = parts.shift()?.trim() ?? "";
	const variableName = variableExpression.split(":")[0]?.trim() ?? "";
	const errors: string[] = [];

	if (!JOURNAL_TEMPLATE_VARIABLES.has(variableName)) {
		return { value: "", errors: [`Unknown variable "${variableName}"`] };
	}

	let value = stringifyTemplateValue(context[variableName]);
	for (const filterExpression of parts) {
		const parsed = parseFilterExpression(filterExpression);
		const filter = FILTERS[parsed.name];
		if (!filter) {
			errors.push(`Unknown filter "${parsed.name}"`);
			continue;
		}
		value = filter(value, parsed.param);
	}
	return { value, errors };
}

function journalTemplateContext(entry: JournalEntryText, now: Date): TemplateContext {
	const current = now.toISOString();
	return {
		id: entry.id,
		uuid: entry.id,
		title: entry.title,
		content: entry.body,
		body: entry.body,
		created: entry.created ?? "",
		modified: entry.updated ?? "",
		updated: entry.updated ?? "",
		date: current,
		time: current,
		music: musicTemplateItems(entry.musicAttachments ?? []),
	};
}

function musicTemplateItems(attachments: JournalMusicAttachment[]): Record<string, unknown>[] {
	return attachments
		.filter((attachment) => attachment.song.trim())
		.map((attachment) => ({
			uuid: attachment.id,
			id: attachment.id,
			source: attachment.source ?? "",
			flags: {
				hidden: attachment.isHidden === true,
				slim: attachment.isSlim === true,
			},
			title: attachment.song.trim(),
			song: attachment.song.trim(),
			artistName: attachment.artistName ?? "",
			artists: splitArtists(attachment.artistName ?? ""),
			mediaId: numericOrString(attachment.mediaId ?? ""),
			mediaType: attachment.mediaType ?? "",
			startTime: attachment.startTime ?? null,
			created: attachment.createdDate ?? "",
			suggestionDate: attachment.suggestionDate ?? "",
		}));
}

function splitArtists(value: string): string[] {
	return value
		.split(/\s*(?:,|&)\s*/g)
		.map((artist) => artist.trim())
		.filter(Boolean);
}

function numericOrString(value: string): string | number {
	const parsed = Number(value);
	return value && Number.isSafeInteger(parsed) ? parsed : value;
}

function stringifyTemplateValue(value: unknown): string {
	if (value === undefined || value === null) {
		return "";
	}
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(value);
}

function coerceFrontmatterValue(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return value;
	}
}

function parseFilterExpression(expression: string): { name: string; param?: string } {
	const index = expression.indexOf(":");
	if (index === -1) {
		return { name: expression.trim() };
	}
	return {
		name: expression.slice(0, index).trim(),
		param: expression.slice(index + 1).trim(),
	};
}

function splitPipeline(expression: string): string[] {
	return splitTopLevel(expression, "|");
}

function splitTopLevel(value: string, delimiter: string): string[] {
	const result: string[] = [];
	let current = "";
	let quote: string | null = null;
	let escaped = false;
	let parenDepth = 0;

	for (const character of value) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			current += character;
			escaped = true;
			continue;
		}
		if (quote) {
			current += character;
			if (character === quote) {
				quote = null;
			}
			continue;
		}
		if (character === "\"" || character === "'") {
			current += character;
			quote = character;
			continue;
		}
		if (character === "(") {
			parenDepth += 1;
		} else if (character === ")") {
			parenDepth = Math.max(0, parenDepth - 1);
		}
		if (character === delimiter && parenDepth === 0) {
			result.push(current.trim());
			current = "";
		} else {
			current += character;
		}
	}

	result.push(current.trim());
	return result.filter((part) => part.length > 0);
}

function stripParamWrapper(param = ""): string {
	return param
		.replace(/^\(([\s\S]*)\)$/, "$1")
		.trim();
}

function stripQuotes(value: string): string {
	return value.trim().replace(/^(['"])([\s\S]*)\1$/, "$2");
}

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

	const pathPrefix = `${argName}.`;
	if (expr.startsWith(pathPrefix)) {
		return readPath(item, expr.slice(pathPrefix.length));
	}
	return expr;
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
		if (regex) {
			return current.replace(regex, replaceWith);
		}
		return current.split(processEscapes(search)).join(replaceWith);
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
			case "n":
				return "\n";
			case "r":
				return "\r";
			case "t":
				return "\t";
			default:
				return character;
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
		return JSON.stringify([...new Set(parsed.map((item) => JSON.stringify(item)))].map((item) => JSON.parse(item) as unknown));
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

function filterSafeName(input: string): string {
	return input
		.replace(/[#|^[\]]/g, "")
		.replace(/[<>:"/\\|?*:]/g, "")
		.split("")
		.filter((character) => character.charCodeAt(0) >= 32)
		.join("")
		.replace(/^\.+/, "")
		.replace(/[\s.]+$/g, "")
		.slice(0, 245)
		.trim() || "Untitled";
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
