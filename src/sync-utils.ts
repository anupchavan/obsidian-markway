import { createHash } from "crypto";
import { realpathSync } from "fs";
import { basename, extname, resolve } from "path";
import { defaultJournalRules, normalizeFilterGroup, type FilterGroup } from "./rules";

export interface MarkwaySettings {
	automaticSync: boolean;
	debounceMs: number;
	vaultPathOverride: string;
	journalFolder: string;
	journalRules: FilterGroup;
	deleteJournalEntryWhenFileDeleted: boolean;
	deleteMarkdownFileWhenJournalDeleted: boolean;
	journalProperties: JournalTemplateProperty[];
	journalIncludeTitleHeading: boolean;
}

export interface JournalTemplateProperty {
	id: string;
	key: string;
	value: string;
}

export interface JournalLink {
	journalID: string;
	path: string;
	title: string;
	lastSyncedAt: string;
	lastMarkdownHash: string;
	lastJournalHash: string;
	lastJournalUpdated: string;
	lastTemplateHash: string;
	lastTemplateSettingsHash: string;
	lastTemplatePropertyKeys: string[];
}

export interface MarkwayPluginData {
	settings: MarkwaySettings;
	journalLinks: Record<string, JournalLink>;
}

export interface JournalEntryText {
	id: string;
	title: string;
	body: string;
	created?: string;
	updated?: string;
	musicAttachments?: JournalMusicAttachment[];
}

export interface JournalMusicAttachment {
	id: string;
	song: string;
	artistName?: string;
	mediaId?: string;
	source?: string;
	isHidden?: boolean;
	isSlim?: boolean;
	mediaType?: string;
	startTime?: number;
	createdDate?: string;
	suggestionDate?: string;
}

export interface JournalEntrySummary {
	id: string;
	status: string;
	created: string;
	updated?: string;
	title: string;
}

export interface SyncOptions {
	includeNew: boolean;
	silent?: boolean;
	migrateFrontmatter?: boolean;
}

export interface MarkdownParts {
	frontmatter: string | null;
	body: string;
}

export const DEFAULT_JOURNAL_FOLDER = "Journal";
export const DEFAULT_JOURNAL_PROPERTIES: JournalTemplateProperty[] = [
	{
		id: "music",
		key: "music",
		value: "{{music|map:item => item.title|wikilink}}",
	},
];

export const DEFAULT_SETTINGS: MarkwaySettings = defaultMarkwaySettings();

export function defaultMarkwaySettings(journalFolder = DEFAULT_JOURNAL_FOLDER): MarkwaySettings {
	return {
		automaticSync: true,
		debounceMs: 1200,
		vaultPathOverride: "",
		journalFolder: normalizeFolder(journalFolder) || DEFAULT_JOURNAL_FOLDER,
		journalRules: defaultJournalRules(journalFolder),
		deleteJournalEntryWhenFileDeleted: false,
		deleteMarkdownFileWhenJournalDeleted: false,
		journalProperties: cloneJournalProperties(DEFAULT_JOURNAL_PROPERTIES),
		journalIncludeTitleHeading: false,
	};
}

export function readPluginData(value: unknown): MarkwayPluginData {
	if (!isRecord(value)) {
		return { settings: defaultMarkwaySettings(), journalLinks: {} };
	}

	const rawSettings = isRecord(value.settings) ? value.settings : value;
	const parsedSettings = readSettings(rawSettings);
	const defaults = defaultMarkwaySettings(parsedSettings.journalFolder ?? DEFAULT_JOURNAL_FOLDER);
	const settings: MarkwaySettings = {
		...defaults,
		...parsedSettings,
		journalRules: parsedSettings.journalRules ?? defaults.journalRules,
	};
	return {
		settings,
		journalLinks: readJournalLinks(value.journalLinks),
	};
}

export function readJournalLinks(value: unknown): Record<string, JournalLink> {
	if (!isRecord(value)) {
		return {};
	}

	const links: Record<string, JournalLink> = {};
	for (const [journalID, rawLink] of Object.entries(value)) {
		if (!isRecord(rawLink)) {
			continue;
		}
		const path = stringValue(rawLink.path);
		if (!path) {
			continue;
		}
		const id = stringValue(rawLink.journalID) || journalID;
		links[id] = {
			journalID: id,
			path: normalizePath(path),
			title: stringValue(rawLink.title) || titleForFile(path),
			lastSyncedAt: stringValue(rawLink.lastSyncedAt) || "",
			lastMarkdownHash: stringValue(rawLink.lastMarkdownHash) || "",
			lastJournalHash: stringValue(rawLink.lastJournalHash) || "",
			lastJournalUpdated: stringValue(rawLink.lastJournalUpdated) || "",
			lastTemplateHash: stringValue(rawLink.lastTemplateHash) || stringValue(rawLink.lastMusicHash) || "",
			lastTemplateSettingsHash: stringValue(rawLink.lastTemplateSettingsHash) || "",
			lastTemplatePropertyKeys: stringArrayValue(rawLink.lastTemplatePropertyKeys),
		};
	}
	return links;
}

export function readSettings(value: unknown): Partial<MarkwaySettings> {
	if (!isRecord(value)) {
		return {};
	}

	const settings: Partial<MarkwaySettings> = {};
	if (typeof value.automaticSync === "boolean") {
		settings.automaticSync = value.automaticSync;
	} else if (value.autoScan === true) {
		settings.automaticSync = true;
	}
	if (typeof value.debounceMs === "number" || typeof value.debounceMs === "string") {
		settings.debounceMs = normalizeDebounceMs(value.debounceMs);
	}
	if (typeof value.vaultPathOverride === "string") {
		settings.vaultPathOverride = value.vaultPathOverride.trim();
	}
	if (typeof value.journalFolder === "string") {
		settings.journalFolder = normalizeFolder(value.journalFolder);
	}
	if (isRecord(value.journalRules)) {
		settings.journalRules = normalizeFilterGroup(
			value.journalRules,
			defaultJournalRules(settings.journalFolder ?? DEFAULT_JOURNAL_FOLDER)
		);
	}
	if (typeof value.deleteJournalEntryWhenFileDeleted === "boolean") {
		settings.deleteJournalEntryWhenFileDeleted = value.deleteJournalEntryWhenFileDeleted;
	}
	if (typeof value.deleteMarkdownFileWhenJournalDeleted === "boolean") {
		settings.deleteMarkdownFileWhenJournalDeleted = value.deleteMarkdownFileWhenJournalDeleted;
	}
	if (Array.isArray(value.journalProperties)) {
		settings.journalProperties = normalizeJournalProperties(value.journalProperties);
	} else if (typeof value.musicField === "string") {
		settings.journalProperties = [
			{
				id: "music",
				key: normalizeTemplatePropertyKey(value.musicField),
				value: "{{music|map:item => item.title|wikilink}}",
			},
		];
	}
	if (typeof value.journalIncludeTitleHeading === "boolean") {
		settings.journalIncludeTitleHeading = value.journalIncludeTitleHeading;
	}
	return settings;
}

export function validateDebounceValue(value: number): string | void {
	if (!Number.isFinite(value) || value < 250) {
		return "Use 250 ms or more.";
	}
}

export function normalizeDebounceMs(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	return Number.isFinite(parsed) ? Math.max(250, Math.round(parsed)) : DEFAULT_SETTINGS.debounceMs;
}

export function mergeSyncOptions(existing: SyncOptions | null, next: SyncOptions): SyncOptions {
	if (!existing) {
		return next;
	}

	return {
		includeNew: existing.includeNew || next.includeNew,
		silent: existing.silent === true && next.silent === true,
		migrateFrontmatter: existing.migrateFrontmatter === true || next.migrateFrontmatter === true,
	};
}

export function hasMatchingJournalSummary(link: JournalLink, summary: JournalEntrySummary): boolean {
	return Boolean(summary.updated)
		&& link.lastJournalUpdated === summary.updated
		&& link.title === summary.title;
}

export function sameVaultPath(left: string, right?: string): boolean {
	if (!right) {
		return false;
	}

	const normalizedLeft = normalizePath(left);
	const normalizedRight = normalizePath(right);
	return normalizedLeft === normalizedRight || normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
}

export function vaultPathKey(path: string): string {
	return normalizePath(path).toLowerCase();
}

export function isFileExistsError(value: unknown): boolean {
	const message = describeUnknown(value).toLowerCase();
	return message.includes("file already exists") || message.includes("eexist");
}

export function splitMarkdown(markdown: string): MarkdownParts {
	const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { frontmatter: null, body: normalized };
	}
	const close = normalized.indexOf("\n---\n", 4);
	if (close === -1) {
		return { frontmatter: null, body: normalized };
	}
	return {
		frontmatter: normalized.slice(0, close + 5),
		body: normalized.slice(close + 5),
	};
}

export function composeMarkdown(frontmatter: string | null, body: string): string {
	return frontmatter ? `${frontmatter}${body}` : body;
}

export function preserveMarkdownStructure(existingBody: string, journalBody: string): string {
	const existing = normalizeLineEndings(existingBody).split("\n");
	const journal = normalizeLineEndings(journalBody).split("\n");
	if (!existingBody.trim()) {
		return journalBody;
	}

	const output: string[] = [];
	let journalIndex = 0;
	let existingIndex = 0;

	while (existingIndex < existing.length) {
		const existingLine = existing[existingIndex] ?? "";

		if (isBlank(existingLine)) {
			if (journalIndex < journal.length && isBlank(journal[journalIndex] ?? "")) {
				output.push(journal[journalIndex] ?? "");
				journalIndex += 1;
			} else {
				output.push(existingLine);
			}
			existingIndex += 1;
			continue;
		}

		if (isFenceStart(existingLine)) {
			const codeBlock = collectFencedBlock(existing, existingIndex);
			const journalCode = takeJournalCodeBlock(journal, journalIndex, codeBlock.content.length);
			output.push(codeBlock.opening);
			output.push(...journalCode.lines);
			output.push(codeBlock.closing);
			journalIndex = journalCode.nextIndex;
			existingIndex = codeBlock.nextIndex;
			continue;
		}

		const journalLine = takeJournalContentLine(journal, journalIndex);
		const current = journalLine.line ?? existingLine;
		journalIndex = journalLine.nextIndex;

		const heading = existingLine.match(/^(\s{0,3})(#{1,6})\s+(.*)$/);
		if (heading) {
			output.push(`${heading[1] ?? ""}${heading[2] ?? "#"} ${markdownLineText(current)}`);
			existingIndex += 1;
			continue;
		}

		const quote = existingLine.match(/^(\s{0,3}>\s?)(.*)$/);
		if (quote) {
			output.push(`${quote[1] ?? "> "}${markdownLineText(current)}`);
			existingIndex += 1;
			continue;
		}

		if (isThematicBreak(existingLine)) {
			if (isThematicBreak(current)) {
				journalIndex = journalLine.nextIndex;
			} else {
				journalIndex = journalLine.startIndex;
			}
			output.push(existingLine);
			existingIndex += 1;
			continue;
		}

		const list = existingLine.match(/^(\s*)((?:[-*+])|(?:\d+[.)]))\s+(.*)$/);
		if (list && !current.match(/^(\s*)((?:[-*+])|(?:\d+[.)]))\s+/)) {
			output.push(`${list[1] ?? ""}${list[2] ?? "-"} ${markdownLineText(current)}`);
			existingIndex += 1;
			continue;
		}

		output.push(current);
		existingIndex += 1;
	}

	if (journalIndex < journal.length) {
		output.push(...journal.slice(journalIndex));
	}

	return output.join("\n");
}

export function hashJournalContent(title: string, body: string): string {
	return sha256Hex(`${title}\0${body}`);
}

export function titleForFile(path: string): string {
	return basename(path, extname(path)).trim() || "Journal Entry";
}

export function sanitizeFileName(value: string): string {
	const trimmed = value.trim() || "Journal Entry";
	return trimmed
		.replace(/[/:]/g, "-")
		.split("")
		.filter((character) => character.charCodeAt(0) >= 32)
		.join("")
		.replace(/\s+/g, " ")
		.slice(0, 180)
		.trim() || "Journal Entry";
}

export function normalizeFolder(value: string): string {
	return normalizePath(value.trim()).replace(/^\/+|\/+$/g, "");
}

export function normalizeJournalProperties(value: unknown): JournalTemplateProperty[] {
	if (!Array.isArray(value)) {
		return cloneJournalProperties(DEFAULT_JOURNAL_PROPERTIES);
	}

	const properties: JournalTemplateProperty[] = [];
	for (const [index, rawProperty] of value.entries()) {
		if (!isRecord(rawProperty)) {
			continue;
		}

		const key = normalizeTemplatePropertyKey(stringValue(rawProperty.key));
		if (!key) {
			continue;
		}

		properties.push({
			id: stringValue(rawProperty.id) || `property-${index}`,
			key,
			value: typeof rawProperty.value === "string" ? rawProperty.value : "",
		});
	}

	return properties;
}

export function normalizeTemplatePropertyKey(value: string): string {
	return value.trim();
}

export function cloneJournalProperties(properties: JournalTemplateProperty[]): JournalTemplateProperty[] {
	return properties.map((property) => ({ ...property }));
}

export function normalizePath(path: string): string {
	return path
		.replace(/\\/g, "/")
		.replace(/\/{2,}/g, "/")
		.replace(/\/$/g, "");
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isBlank(line: string): boolean {
	return line.trim() === "";
}

function isFenceStart(line: string): boolean {
	return /^ {0,3}(`{3,}|~{3,})/.test(line);
}

function isFenceClose(line: string, opener: string): boolean {
	const marker = opener.trimStart().startsWith("~") ? "~" : "`";
	const length = opener.trimStart().match(/^(`{3,}|~{3,})/)?.[0]?.length ?? 3;
	return new RegExp(`^ {0,3}${escapeRegExp(marker.repeat(length))}\\s*$`).test(line);
}

function collectFencedBlock(lines: string[], start: number): { opening: string; closing: string; content: string[]; nextIndex: number } {
	const opening = lines[start] ?? "```";
	const content: string[] = [];
	let index = start + 1;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (isFenceClose(line, opening)) {
			return { opening, closing: line, content, nextIndex: index + 1 };
		}
		content.push(line);
		index += 1;
	}
	return { opening, closing: opening.trimStart().startsWith("~") ? "~~~" : "```", content, nextIndex: index };
}

function takeJournalCodeBlock(lines: string[], start: number, fallbackLength: number): { lines: string[]; nextIndex: number } {
	let index = skipBlankLines(lines, start);
	const opener = lines[index] ?? "";
	if (isFenceStart(opener)) {
		const block = collectFencedBlock(lines, index);
		return { lines: block.content, nextIndex: block.nextIndex };
	}

	const content: string[] = [];
	const length = Math.max(1, fallbackLength);
	while (index < lines.length && content.length < length) {
		const line = lines[index] ?? "";
		if (isBlank(line) && content.length > 0) {
			break;
		}
		content.push(line);
		index += 1;
	}
	return { lines: content, nextIndex: index };
}

function takeJournalContentLine(lines: string[], start: number): { line: string | null; startIndex: number; nextIndex: number } {
	const contentIndex = skipBlankLines(lines, start);
	if (contentIndex >= lines.length) {
		return { line: null, startIndex: start, nextIndex: contentIndex };
	}
	return { line: lines[contentIndex] ?? "", startIndex: contentIndex, nextIndex: contentIndex + 1 };
}

function skipBlankLines(lines: string[], start: number): number {
	let index = start;
	while (index < lines.length && isBlank(lines[index] ?? "")) {
		index += 1;
	}
	return index;
}

function markdownLineText(line: string): string {
	let text = line.trim();
	const heading = text.match(/^#{1,6}\s+(.*)$/);
	if (heading) {
		text = heading[1] ?? "";
	}
	const quote = text.match(/^>\s?(.*)$/);
	if (quote) {
		text = quote[1] ?? "";
	}
	const list = text.match(/^((?:[-*+])|(?:\d+[.)]))\s+(.*)$/);
	if (list) {
		text = list[2] ?? "";
	}
	const wrappers = [
		/^\*\*\*(.*)\*\*\*$/,
		/^___(.*)___$/,
		/^\*\*(.*)\*\*$/,
		/^__(.*)__$/,
		/^\*(.*)\*$/,
		/^_(.*)_$/,
		/^`(.*)`$/,
	];
	let changed = true;
	while (changed) {
		changed = false;
		for (const wrapper of wrappers) {
			const match = text.match(wrapper);
			if (match) {
				text = match[1] ?? "";
				changed = true;
			}
		}
	}
	return text;
}

function isThematicBreak(line: string): boolean {
	return /^ {0,3}((?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/.test(line);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function canonicalPath(path: string): string {
	try {
		return realpathSync.native(path);
	} catch {
		return resolve(path);
	}
}

export function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function stringValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

export function describeUnknown(value: unknown): string {
	if (value instanceof Error) {
		return value.message;
	}
	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value) ?? "Unknown error";
	} catch {
		return "Unknown error";
	}
}

export function explainMarkwayError(value: unknown): string {
	const message = describeUnknown(value);
	if (
		message.includes("group.com.apple.moments")
		|| message.includes("Sandbox access to file-read-data denied")
		|| message.includes("Apple Journal access was denied")
		|| message.includes("moments.sqlite")
	) {
		return [
			"macOS denied Markway.app access to Apple Journal.",
			"Grant Full Disk Access to Markway.app, fully quit and reopen Markway.app, then start the bridge again.",
		].join(" ");
	}

	return message;
}

export function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
