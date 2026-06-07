import type { JournalEntryText, JournalMusicAttachment } from "../sync-utils";

export type TemplateContext = Record<string, unknown>;

export function journalTemplateContext(entry: JournalEntryText, now: Date): TemplateContext {
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

export function coerceFrontmatterValue(value: string): unknown {
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
