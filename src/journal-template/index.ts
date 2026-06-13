import {
	DEFAULT_JOURNAL_CONTENT_TEMPLATE,
	frontmatterComparableValues,
	sha256Hex,
	type GeneratedAttachmentPropertyItem,
	type JournalBodySection,
	type JournalEntryText,
	type MarkwaySettings,
} from "../sync-utils";
import { coerceFrontmatterValue, journalTemplateContext } from "./context";
import { renderTemplate, templateVariableNames, validateTemplateVariables } from "./engine";
import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat";

dayjs.extend(customParseFormat);

export { JOURNAL_TEMPLATE_VARIABLES, validateTemplateVariables } from "./engine";

export interface TemplateRenderResult {
	properties: Record<string, unknown>;
	hash: string;
	errors: TemplateValidationError[];
	attachmentPropertyItems: Record<string, GeneratedAttachmentPropertyItem[]>;
}

export interface TemplateValidationError {
	propertyID: string;
	message: string;
}

const MUSIC_TEMPLATE_NAMES = new Set(["music", "attachments"]);
const PHOTO_TEMPLATE_NAMES = new Set(["photos", "attachments"]);
const GENERIC_ATTACHMENT_TEMPLATE_NAMES = new Set(["attachments", "places", "reflection"]);

export function journalTemplateNeedsMusic(settings: MarkwaySettings): boolean {
	return journalTemplateUses(settings, MUSIC_TEMPLATE_NAMES);
}

export function journalTemplateNeedsPhotos(settings: MarkwaySettings): boolean {
	return settings.journalPhotosProperty.trim().length > 0
		|| journalTemplateUses(settings, PHOTO_TEMPLATE_NAMES);
}

export function journalTemplateNeedsAttachments(settings: MarkwaySettings): boolean {
	return journalTemplateUses(settings, GENERIC_ATTACHMENT_TEMPLATE_NAMES);
}

export function journalTemplateNeedsAttachmentMetadata(settings: MarkwaySettings): boolean {
	return journalTemplateNeedsMusic(settings)
		|| journalTemplateNeedsPhotos(settings)
		|| journalTemplateNeedsAttachments(settings);
}

export function templateUsesAttachments(template: string): boolean {
	return templateUsesVariable(template, MUSIC_TEMPLATE_NAMES)
		|| templateUsesVariable(template, PHOTO_TEMPLATE_NAMES)
		|| templateUsesVariable(template, GENERIC_ATTACHMENT_TEMPLATE_NAMES);
}

export function journalTemplateSettingsHash(settings: MarkwaySettings): string {
	return sha256Hex(JSON.stringify({
		properties: settings.journalProperties,
		includeTitleHeading: settings.journalIncludeTitleHeading,
		contentTemplate: settings.journalContentTemplate,
		photosProperty: settings.journalPhotosProperty,
	}));
}

export function renderJournalTemplateProperties(
	entry: JournalEntryText,
	settings: MarkwaySettings,
	now = new Date(),
	photoFiles: Record<string, string> = {}
): TemplateRenderResult {
	const context = journalTemplateContext(entry, now, photoFiles);
	const properties: Record<string, unknown> = {};
	const errors: TemplateValidationError[] = [];
	const attachmentPropertyItems: Record<string, GeneratedAttachmentPropertyItem[]> = {};

	for (const property of settings.journalProperties) {
		const key = property.key.trim();
		if (!key) {
			continue;
		}

		const rendered = renderTemplate(property.value, context);
		if (rendered.errors.length > 0) {
			errors.push(...rendered.errors.map((message) => ({ propertyID: property.id, message })));
		}
		const value = coerceFrontmatterValue(rendered.value);
		if (isEmptyFrontmatterValue(value)) {
			continue;
		}
		properties[key] = value;
		const items = renderAttachmentPropertyItems(entry, property.value, now, photoFiles);
		if (items.length > 0) {
			attachmentPropertyItems[key] = items;
		}
	}

	const settingsHash = journalTemplateSettingsHash(settings);
	const hash = sha256Hex(JSON.stringify({ settingsHash, properties }));
	return { properties, hash, errors, attachmentPropertyItems };
}

export function isEmptyFrontmatterValue(value: unknown): boolean {
	if (value === null || value === undefined || value === "") {
		return true;
	}
	if (Array.isArray(value)) {
		return value.length === 0;
	}
	if (typeof value === "object") {
		return Object.keys(value).length === 0;
	}
	return false;
}

const CONTENT_ANCHOR_NAMES = new Set(["content", "body", "entry.content", "entry.body"]);

export function splitContentTemplate(template: string): { prefix: string; suffix: string } | null {
	for (const match of template.matchAll(/\{\{\s*([\s\S]*?)\s*\}\}/g)) {
		const expression = (match[1] ?? "").trim();
		if (CONTENT_ANCHOR_NAMES.has(expression)) {
			const start = match.index ?? 0;
			return {
				prefix: template.slice(0, start),
				suffix: template.slice(start + match[0].length),
			};
		}
	}
	return null;
}

export const CONTENT_SECTION_MARKER = "%% content %%";

/// Renders the content template as ordered body sections. Generated sections
/// carry %% label %% markers so the boundary between template output and the
/// journal text stays explicit in the file; a plain {{content}} template
/// produces a single unmarked content section.
export function renderJournalBodySections(
	entry: JournalEntryText,
	settings: MarkwaySettings,
	photoFiles: Record<string, string> = {},
	now = new Date()
): JournalBodySection[] {
	const template = settings.journalContentTemplate.trim()
		? settings.journalContentTemplate
		: DEFAULT_JOURNAL_CONTENT_TEMPLATE;
	const plainContent: JournalBodySection[] = [{ kind: "content", marker: "", text: entry.body }];

	// Without an unfiltered {{content}} anchor the journal text cannot be
	// separated from generated content on push, so sync the text alone.
	const split = splitContentTemplate(template);
	if (!split) {
		return plainContent;
	}
	const hasPrefix = split.prefix.trim().length > 0;
	const hasSuffix = split.suffix.trim().length > 0;
	if (!hasPrefix && !hasSuffix) {
		return plainContent;
	}

	const context = journalTemplateContext(entry, now, photoFiles);
	const sections: JournalBodySection[] = [];
	if (hasPrefix) {
		const rendered = renderTemplate(split.prefix, context);
		if (rendered.errors.length > 0) {
			return plainContent;
		}
		sections.push({
			kind: "generated",
			marker: generatedSectionMarker(split.prefix),
			text: normalizeTemplateLineEndings(rendered.value).trim(),
		});
	}
	sections.push({
		kind: "content",
		marker: hasPrefix ? CONTENT_SECTION_MARKER : "",
		text: entry.body,
	});
	if (hasSuffix) {
		const rendered = renderTemplate(split.suffix, context);
		if (rendered.errors.length > 0) {
			return plainContent;
		}
		sections.push({
			kind: "generated",
			marker: generatedSectionMarker(split.suffix),
			text: normalizeTemplateLineEndings(rendered.value).trim(),
		});
	}
	return sections;
}

export function serializeJournalBody(sections: JournalBodySection[]): string {
	return sections
		.map((section) => (section.marker ? `${section.marker}\n${section.text}` : section.text))
		.join("\n\n");
}

/// Recovers section texts from a note body using the marker layout recorded
/// at the last sync. Returns null when the markers are gone, which means the
/// user dissolved the structure and owns the whole body.
export function parseJournalBodySections(
	body: string,
	layout: Pick<JournalBodySection, "kind" | "marker">[]
): JournalBodySection[] | null {
	if (layout.length === 0 || !layout.some((section) => section.marker)) {
		return null;
	}

	const lines = normalizeTemplateLineEndings(body).split("\n");
	const markerLines: number[] = [];
	let searchFrom = 0;
	for (const section of layout) {
		if (!section.marker) {
			markerLines.push(-1);
			continue;
		}
		let found = -1;
		for (let index = searchFrom; index < lines.length; index += 1) {
			if (lines[index]?.trim() === section.marker) {
				found = index;
				break;
			}
		}
		if (found === -1) {
			return null;
		}
		markerLines.push(found);
		searchFrom = found + 1;
	}

	return layout.map((section, index) => {
		const start = markerLines[index] === -1 ? 0 : (markerLines[index] ?? 0) + 1;
		const nextMarker = markerLines
			.slice(index + 1)
			.find((line) => line !== -1);
		const end = nextMarker === undefined ? lines.length : nextMarker;
		const sectionLines = lines.slice(start, end);
		// serializeJournalBody separates sections with one blank line, which
		// belongs to the layout rather than to the section text.
		if (nextMarker !== undefined && sectionLines[sectionLines.length - 1] === "") {
			sectionLines.pop();
		}
		return { kind: section.kind, marker: section.marker, text: sectionLines.join("\n") };
	});
}

export function journalBodyContent(
	body: string,
	layout: Pick<JournalBodySection, "kind" | "marker">[]
): string | null {
	const sections = parseJournalBodySections(body, layout);
	if (!sections) {
		return null;
	}
	return sections.find((section) => section.kind === "content")?.text ?? null;
}

function generatedSectionMarker(segmentTemplate: string): string {
	const names = new Set<string>();
	for (const variable of templateVariableNames(segmentTemplate)) {
		const segments = variable.split(".");
		const root = segments[0] ?? "";
		const name = root === "entry" && segments.length > 1 ? segments[1] ?? "" : root;
		if (name && !CONTENT_ANCHOR_NAMES.has(name)) {
			names.add(name);
		}
	}
	const label = [...names].join(", ") || "generated";
	return `%% ${label} %%`;
}

export function renderJournalNoteName(
	entry: JournalEntryText,
	settings: MarkwaySettings,
	now = new Date()
): string {
	const template = settings.journalNoteNameTemplate.trim();
	if (!template) {
		return entry.title;
	}
	const rendered = renderTemplate(template, journalTemplateContext(entry, now));
	if (rendered.errors.length > 0) {
		return entry.title;
	}
	const name = rendered.value.replace(/\s+/g, " ").trim();
	return name || entry.title;
}

/// Inverts the note name template to recover the journal title from a file
/// name. Date-formatted variables match their digit shapes so a name like
/// "2026-06-11 1530 My Title" maps back to "My Title"; other variables match
/// lazily. Without a {{title}} slot (or on mismatch) the whole name is the
/// title.
export function journalTitleFromNoteName(name: string, template: string): string {
	const trimmed = template.trim();
	if (!trimmed || trimmed === "{{title}}") {
		return name;
	}

	let pattern = "";
	let lastIndex = 0;
	let hasTitleGroup = false;
	for (const match of trimmed.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
		pattern += noteNameLiteralPattern(trimmed.slice(lastIndex, match.index ?? 0));
		const expression = (match[1] ?? "").trim();
		const segments = expression.split("|");
		const root = segments[0]?.trim() ?? "";
		if (!hasTitleGroup && (root === "title" || root === "entry.title")) {
			pattern += "(.+)";
			hasTitleGroup = true;
		} else {
			pattern += noteNameVariablePattern(segments.slice(1));
		}
		lastIndex = (match.index ?? 0) + match[0].length;
	}
	pattern += noteNameLiteralPattern(trimmed.slice(lastIndex));

	if (!hasTitleGroup) {
		return name;
	}
	const result = new RegExp(`^${pattern}$`).exec(name);
	return result?.[1]?.trim() || name;
}

export interface JournalNoteNameDate {
	raw: string;
	format: string;
	date: Date;
	hasDate: boolean;
	hasTime: boolean;
}

export function journalCreatedDateFromNoteName(name: string, template: string): JournalNoteNameDate | null {
	const trimmed = template.trim();
	if (!trimmed) {
		return null;
	}

	let pattern = "";
	let lastIndex = 0;
	let groupIndex = 0;
	let createdGroupIndex = -1;
	let createdFormat = "";
	for (const match of trimmed.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
		pattern += noteNameLiteralPattern(trimmed.slice(lastIndex, match.index ?? 0));
		const expression = (match[1] ?? "").trim();
		const segments = expression.split("|");
		const root = segments[0]?.trim() ?? "";
		const filters = segments.slice(1);
		if (createdGroupIndex === -1 && (root === "created" || root === "entry.created")) {
			const format = dateFilterFormat(filters);
			if (!format) {
				return null;
			}
			pattern += `(${dateFormatPattern(format)})`;
			groupIndex += 1;
			createdGroupIndex = groupIndex;
			createdFormat = format;
		} else if (root === "title" || root === "entry.title") {
			pattern += ".+";
		} else {
			pattern += noteNameVariablePattern(filters);
		}
		lastIndex = (match.index ?? 0) + match[0].length;
	}
	pattern += noteNameLiteralPattern(trimmed.slice(lastIndex));

	if (createdGroupIndex === -1) {
		return null;
	}
	const raw = new RegExp(`^${pattern}$`).exec(name)?.[createdGroupIndex]?.trim() ?? "";
	if (!raw) {
		return null;
	}
	const parsed = parseNoteNameDate(raw, createdFormat);
	if (!parsed.isValid()) {
		return null;
	}
	return {
		raw,
		format: createdFormat,
		date: parsed.toDate(),
		hasDate: dateFormatHasDate(createdFormat),
		hasTime: dateFormatHasTime(createdFormat),
	};
}

function parseNoteNameDate(raw: string, format: string): dayjs.Dayjs {
	const formats = [format, sanitizedDateFormat(format)];
	for (const candidate of [...new Set(formats)]) {
		const parsed = dayjs(raw, candidate, true);
		if (parsed.isValid()) {
			return parsed;
		}
	}
	return dayjs(Number.NaN);
}

function sanitizedDateFormat(format: string): string {
	return format.replace(/[\\/:]/g, "-");
}

function noteNameVariablePattern(filters: string[]): string {
	for (const filter of filters) {
		const format = dateFilterFormat([filter]);
		if (format) {
			return dateFormatPattern(format);
		}
	}
	return ".*?";
}

function dateFilterFormat(filters: string[]): string | null {
	for (const filter of filters) {
		const trimmed = filter.trim();
		if (!trimmed.startsWith("date:")) {
			continue;
		}
		const param = trimmed.slice("date:".length).trim().replace(/^\(([\s\S]*)\)$/, "$1").trim();
		const quoted = param.match(/^(['"])([\s\S]*?)\1/);
		if (quoted?.[2]) {
			return quoted[2];
		}
		const unquoted = param.split(",")[0]?.trim() ?? "";
		return unquoted || null;
	}
	return null;
}

function dateFormatHasTime(format: string): boolean {
	return /(^|[^A-Za-z])(?:H{1,2}|h{1,2}|m{1,2}|s{1,2}|A|a)([^A-Za-z]|$)/.test(stripDateFormatLiterals(format));
}

function dateFormatHasDate(format: string): boolean {
	return /(^|[^A-Za-z])(?:Y{2,4}|M{1,4}|D{1,2}|Do)([^A-Za-z]|$)/.test(stripDateFormatLiterals(format));
}

function stripDateFormatLiterals(format: string): string {
	return format.replace(/\[[^\]]*]/g, "");
}

function dateFormatPattern(format: string): string {
	const tokens: [string, string][] = [
		["YYYY", "\\d{4}"], ["YY", "\\d{2}"],
		["MMMM", "[A-Za-z]+"], ["MMM", "[A-Za-z]+"],
		["MM", "\\d{2}"], ["M", "\\d{1,2}"],
		["DD", "\\d{2}"], ["Do", "\\d{1,2}(?:st|nd|rd|th)"], ["D", "\\d{1,2}"],
		["HH", "\\d{2}"], ["H", "\\d{1,2}"], ["hh", "\\d{2}"], ["h", "\\d{1,2}"],
		["mm", "\\d{2}"], ["m", "\\d{1,2}"], ["ss", "\\d{2}"], ["s", "\\d{1,2}"],
		["A", "[AP]M"], ["a", "[ap]m"],
		["ZZ", "(?:Z|[+-]\\d{4})"], ["Z", "(?:Z|[+-]\\d{2}:?\\d{2})"],
	];
	let out = "";
	let index = 0;
	while (index < format.length) {
		if (format[index] === "[") {
			const close = format.indexOf("]", index + 1);
			if (close !== -1) {
				out += noteNameLiteralPattern(format.slice(index + 1, close));
				index = close + 1;
				continue;
			}
		}
		const token = tokens.find(([tokenName]) => format.startsWith(tokenName, index));
		if (token) {
			out += token[1];
			index += token[0].length;
		} else {
			out += noteNameLiteralPattern(format[index] ?? "");
			index += 1;
		}
	}
	return out;
}

function noteNameLiteralPattern(value: string): string {
	let pattern = "";
	for (const character of value) {
		if (character === ":") {
			pattern += "[:-]";
		} else if (character === "/") {
			pattern += "[/-]";
		} else if (character === "\\") {
			pattern += "[\\\\-]";
		} else {
			pattern += escapeRegExp(character);
		}
	}
	return pattern;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function renderJournalContent(
	entry: JournalEntryText,
	settings: MarkwaySettings,
	now = new Date()
): string {
	const heading = settings.journalIncludeTitleHeading && entry.title.trim()
		? `# ${entry.title.trim()}\n\n`
		: "";
	return `${heading}${serializeJournalBody(renderJournalBodySections(entry, settings, {}, now))}`;
}

export function stripGeneratedContentChrome(body: string, prefix: string, suffix: string): string {
	let result = normalizeTemplateLineEndings(body);
	if (prefix && result.startsWith(prefix)) {
		result = result.slice(prefix.length);
	}
	if (suffix && result.endsWith(suffix)) {
		result = result.slice(0, result.length - suffix.length);
	}
	return result;
}

export function validateContentTemplate(template: string): string[] {
	const messages = validateTemplateVariables(template);
	const effective = template.trim() ? template : DEFAULT_JOURNAL_CONTENT_TEMPLATE;
	if (!splitContentTemplate(effective)) {
		messages.push(
			"Include {{content}} on its own so the journal text stays separate from generated content. Without it, Markway syncs the journal text alone."
		);
	}
	return messages;
}

function normalizeTemplateLineEndings(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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

function journalTemplateUses(settings: MarkwaySettings, names: Set<string>): boolean {
	return settings.journalProperties.some(
		(property) => property.key.trim() && templateUsesVariable(property.value, names)
	) || templateUsesVariable(settings.journalContentTemplate, names);
}

function templateUsesVariable(template: string, names: Set<string>): boolean {
	return templateVariableNames(template).some((variable) => {
		const segments = variable.split(".");
		const root = segments[0] ?? "";
		if (names.has(root)) {
			return true;
		}
		return root === "entry" && segments.length > 1 && names.has(segments[1] ?? "");
	});
}

function renderAttachmentPropertyItems(
	entry: JournalEntryText,
	template: string,
	now: Date,
	photoFiles: Record<string, string> = {}
): GeneratedAttachmentPropertyItem[] {
	const items: GeneratedAttachmentPropertyItem[] = [];
	if (templateUsesVariable(template, MUSIC_TEMPLATE_NAMES)) {
		for (const attachment of entry.musicAttachments ?? []) {
			appendAttachmentPropertyItem(
				items,
				attachment.id,
				template,
				{ ...entry, musicAttachments: [attachment], photoAttachments: [] },
				now,
				photoFiles
			);
		}
	}
	if (templateUsesVariable(template, PHOTO_TEMPLATE_NAMES)) {
		for (const attachment of entry.photoAttachments ?? []) {
			appendAttachmentPropertyItem(
				items,
				attachment.id,
				template,
				{ ...entry, musicAttachments: [], photoAttachments: [attachment] },
				now,
				photoFiles
			);
		}
	}
	return items;
}

function appendAttachmentPropertyItem(
	items: GeneratedAttachmentPropertyItem[],
	attachmentID: string,
	template: string,
	singleAttachmentEntry: JournalEntryText,
	now: Date,
	photoFiles: Record<string, string> = {}
): void {
	if (!attachmentID) {
		return;
	}

	const rendered = renderTemplate(template, journalTemplateContext(singleAttachmentEntry, now, photoFiles));
	const values = frontmatterComparableValues(coerceFrontmatterValue(rendered.value));
	const value = values.length === 1 ? values[0] : undefined;
	if (value) {
		items.push({ id: attachmentID, value });
	}
}
