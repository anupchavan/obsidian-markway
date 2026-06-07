import {
	frontmatterComparableValues,
	sha256Hex,
	type GeneratedMusicPropertyItem,
	type JournalEntryText,
	type MarkwaySettings,
} from "../sync-utils";
import { coerceFrontmatterValue, journalTemplateContext } from "./context";
import { renderTemplate } from "./engine";

export { JOURNAL_TEMPLATE_VARIABLES, validateTemplateVariables } from "./engine";

export interface TemplateRenderResult {
	properties: Record<string, unknown>;
	hash: string;
	errors: TemplateValidationError[];
	musicPropertyItems: Record<string, GeneratedMusicPropertyItem[]>;
}

export interface TemplateValidationError {
	propertyID: string;
	message: string;
}

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
	const musicPropertyItems: Record<string, GeneratedMusicPropertyItem[]> = {};

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
		if (property.value.includes("{{music")) {
			const items = renderMusicPropertyItems(entry, property.value, now);
			if (items.length > 0) {
				musicPropertyItems[key] = items;
			}
		}
	}

	const settingsHash = journalTemplateSettingsHash(settings);
	const hash = sha256Hex(JSON.stringify({ settingsHash, properties }));
	return { properties, hash, errors, musicPropertyItems };
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

function renderMusicPropertyItems(
	entry: JournalEntryText,
	template: string,
	now: Date
): GeneratedMusicPropertyItem[] {
	const items: GeneratedMusicPropertyItem[] = [];
	for (const attachment of entry.musicAttachments ?? []) {
		if (!attachment.id) {
			continue;
		}

		const rendered = renderTemplate(template, journalTemplateContext({ ...entry, musicAttachments: [attachment] }, now));
		const values = frontmatterComparableValues(coerceFrontmatterValue(rendered.value));
		if (values.length === 1 && values[0]) {
			items.push({ id: attachment.id, value: values[0] });
		}
	}
	return items;
}
