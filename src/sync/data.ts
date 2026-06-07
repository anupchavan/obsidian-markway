import { defaultJournalRules, normalizeFilterGroup } from "../rules";
import {
	normalizeFolder,
	normalizePath,
	titleForFile,
} from "./paths";
import { isRecord, stringValue } from "./primitives";
import type {
	GeneratedMusicPropertyItem,
	JournalLink,
	JournalTemplateProperty,
	MarkwayPluginData,
	MarkwaySettings,
} from "./types";

const DEFAULT_DEBOUNCE_MS = 1200;

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
		debounceMs: DEFAULT_DEBOUNCE_MS,
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
	return {
		settings: {
			...defaults,
			...parsedSettings,
			journalRules: parsedSettings.journalRules ?? defaults.journalRules,
		},
		journalLinks: readJournalLinks(value.journalLinks),
	};
}

export function readJournalLinks(value: unknown): Record<string, JournalLink> {
	if (!isRecord(value)) {
		return {};
	}

	const links: Record<string, JournalLink> = {};
	for (const [journalID, rawLink] of Object.entries(value)) {
		const link = readJournalLink(journalID, rawLink);
		if (link) {
			links[link.journalID] = link;
		}
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
	readDeleteSettings(value, settings);
	readTemplateSettings(value, settings);
	return settings;
}

export function validateDebounceValue(value: number): string | void {
	if (!Number.isFinite(value) || value < 250) {
		return "Use 250 ms or more.";
	}
}

export function normalizeDebounceMs(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value), 10);
	return Number.isFinite(parsed) ? Math.max(250, Math.round(parsed)) : DEFAULT_DEBOUNCE_MS;
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
		if (key) {
			properties.push({
				id: stringValue(rawProperty.id) || `property-${index}`,
				key,
				value: typeof rawProperty.value === "string" ? rawProperty.value : "",
			});
		}
	}
	return properties;
}

export function normalizeTemplatePropertyKey(value: string): string {
	return value.trim();
}

export function cloneJournalProperties(properties: JournalTemplateProperty[]): JournalTemplateProperty[] {
	return properties.map((property) => ({ ...property }));
}

export function frontmatterComparableValues(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.map(frontmatterComparableValue).filter(Boolean);
	}
	const single = frontmatterComparableValue(value);
	return single ? [single] : [];
}

export function removedGeneratedMusicAttachmentIDs(
	previousItems: GeneratedMusicPropertyItem[],
	currentValue: unknown
): string[] {
	const previousValues = previousItems.map((item) => item.value).filter(Boolean);
	const currentValues = frontmatterComparableValues(currentValue);
	if (previousValues.length === 0 || currentValues.length >= previousValues.length) {
		return [];
	}

	const currentCounts = countedValues(currentValues);
	const previousCounts = countedValues(previousValues);
	const missingItems = previousItems.filter((item) => {
		if (!item.value || (previousCounts.get(item.value) ?? 0) > 1) {
			return false;
		}
		const count = currentCounts.get(item.value) ?? 0;
		currentCounts.set(item.value, Math.max(0, count - 1));
		return count === 0;
	});

	const removedCount = previousValues.length - currentValues.length;
	return missingItems.length === removedCount ? missingItems.map((item) => item.id) : [];
}

function readJournalLink(journalID: string, rawLink: unknown): JournalLink | null {
	if (!isRecord(rawLink)) {
		return null;
	}
	const path = stringValue(rawLink.path);
	if (!path) {
		return null;
	}
	const id = stringValue(rawLink.journalID) || journalID;
	return {
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
		lastTemplateProperties: recordValue(rawLink.lastTemplateProperties),
		lastMusicPropertyItems: readMusicPropertyItems(rawLink.lastMusicPropertyItems),
	};
}

function readDeleteSettings(value: Record<string, unknown>, settings: Partial<MarkwaySettings>): void {
	if (typeof value.deleteJournalEntryWhenFileDeleted === "boolean") {
		settings.deleteJournalEntryWhenFileDeleted = value.deleteJournalEntryWhenFileDeleted;
	}
	if (typeof value.deleteMarkdownFileWhenJournalDeleted === "boolean") {
		settings.deleteMarkdownFileWhenJournalDeleted = value.deleteMarkdownFileWhenJournalDeleted;
	}
}

function readTemplateSettings(value: Record<string, unknown>, settings: Partial<MarkwaySettings>): void {
	if (Array.isArray(value.journalProperties)) {
		settings.journalProperties = normalizeJournalProperties(value.journalProperties);
	} else if (typeof value.musicField === "string") {
		settings.journalProperties = [{
			id: "music",
			key: normalizeTemplatePropertyKey(value.musicField),
			value: "{{music|map:item => item.title|wikilink}}",
		}];
	}
	if (typeof value.journalIncludeTitleHeading === "boolean") {
		settings.journalIncludeTitleHeading = value.journalIncludeTitleHeading;
	}
}

function stringArrayValue(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function recordValue(value: unknown): Record<string, unknown> {
	return isRecord(value) ? { ...value } : {};
}

function readMusicPropertyItems(value: unknown): Record<string, GeneratedMusicPropertyItem[]> {
	if (!isRecord(value)) {
		return {};
	}
	const result: Record<string, GeneratedMusicPropertyItem[]> = {};
	for (const [key, rawItems] of Object.entries(value)) {
		const items = Array.isArray(rawItems) ? rawItems.flatMap(readMusicPropertyItem) : [];
		if (items.length > 0) {
			result[key] = items;
		}
	}
	return result;
}

function readMusicPropertyItem(item: unknown): GeneratedMusicPropertyItem[] {
	if (!isRecord(item)) {
		return [];
	}
	const id = stringValue(item.id);
	const comparableValue = stringValue(item.value);
	return id && comparableValue ? [{ id, value: comparableValue }] : [];
}

function frontmatterComparableValue(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	if (typeof value === "string") {
		return value.trim();
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	try {
		return JSON.stringify(value);
	} catch {
		return "";
	}
}

function countedValues(values: string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const value of values) {
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	return counts;
}
