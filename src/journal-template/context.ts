import type {
	JournalAttachmentFile,
	JournalEntryText,
	JournalGenericAttachment,
	JournalMusicAttachment,
	JournalPhotoAttachment,
} from "../sync-utils";

export type TemplateContext = Record<string, unknown>;

export const ENTRY_TEMPLATE_KEYS = new Set([
	"id",
	"uuid",
	"title",
	"content",
	"body",
	"created",
	"modified",
	"updated",
	"music",
	"photos",
	"reflection",
	"attachments",
	"places",
]);

export function journalTemplateContext(
	entry: JournalEntryText,
	now: Date,
	photoFiles: Record<string, string> = {}
): TemplateContext {
	const current = now.toISOString();
	const music = musicTemplateItems(entry.musicAttachments ?? []);
	const photos = photoTemplateItems(entry.photoAttachments ?? [], photoFiles);
	const attachments = attachmentTemplateItems(entry, music, photos, photoFiles);
	const reflection = attachments.filter((attachment) => attachment.assetType === "reflection");
	const places = placeTemplateItems(entry.attachments ?? []);
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
		music,
		photos,
		reflection,
		attachments,
		places,
		entry: entryTemplateObject(entry, music, photos, reflection, attachments, places),
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

function entryTemplateObject(
	entry: JournalEntryText,
	music: Record<string, unknown>[],
	photos: Record<string, unknown>[],
	reflection: Record<string, unknown>[],
	attachments: Record<string, unknown>[],
	places: Record<string, unknown>[]
): Record<string, unknown> {
	return {
		id: entry.id,
		uuid: entry.id,
		title: entry.title,
		content: entry.body,
		body: entry.body,
		created: entry.created ?? "",
		modified: entry.updated ?? "",
		updated: entry.updated ?? "",
		music,
		photos,
		reflection,
		attachments,
		places,
	};
}

const MAP_ASSET_TYPES = new Set(["multiPinMap", "genericMap"]);

function placeTemplateItems(attachments: JournalGenericAttachment[]): Record<string, unknown>[] {
	const places: Record<string, unknown>[] = [];
	for (const attachment of attachments) {
		if (!MAP_ASSET_TYPES.has(attachment.assetType)) {
			continue;
		}
		for (const visit of visitTemplateItems(attachment.metadata ?? {})) {
			places.push({
				...visit,
				uuid: attachment.id,
				id: attachment.id,
				type: "place",
				assetType: attachment.assetType,
				title: visit.placeName || visit.city,
			});
		}
	}
	return places;
}

function attachmentTemplateItems(
	entry: JournalEntryText,
	music: Record<string, unknown>[],
	photos: Record<string, unknown>[],
	photoFiles: Record<string, string>
): Record<string, unknown>[] {
	const generic = entry.attachments ?? [];
	if (generic.length === 0) {
		// Older Markway.app builds do not return the combined list.
		return [...music, ...photos];
	}
	return generic
		.filter((attachment) => attachment.id)
		.map((attachment) => genericTemplateItem(attachment, photoFiles));
}

function genericTemplateItem(
	attachment: JournalGenericAttachment,
	photoFiles: Record<string, string>
): Record<string, unknown> {
	const files = (attachment.files ?? []).map(photoTemplateFile);
	const primary = files.find((file) => file.name === "image") ?? files[0];
	const metadata = attachment.metadata ?? {};
	const vaultPath = photoFiles[attachment.id];
	const item: Record<string, unknown> = {
		uuid: attachment.id,
		id: attachment.id,
		type: attachment.assetType,
		assetType: attachment.assetType,
		source: attachment.source ?? "",
		flags: {
			hidden: attachment.isHidden === true,
			slim: attachment.isSlim === true,
		},
		created: attachment.createdDate ?? "",
		suggestionDate: attachment.suggestionDate ?? "",
		files,
		fileName: vaultPath ? lastPathComponent(vaultPath) : primary?.fileName ?? "",
		path: vaultPath ?? primary?.path ?? "",
		title: vaultPath ? lastPathComponent(vaultPath) : primary?.fileName ?? "",
		metadata,
	};

	switch (attachment.assetType) {
		case "music": {
			const song = metadataString(metadata, "song");
			const artistName = metadataString(metadata, "artistName");
			item.title = song;
			item.song = song;
			item.artistName = artistName;
			item.artists = splitArtists(artistName);
			item.mediaId = numericOrString(metadataString(metadata, "mediaId"));
			break;
		}
		case "reflection": {
			const prompt = metadataString(metadata, "prompt");
			item.title = prompt;
			item.prompt = prompt;
			item.colorLight = metadataString(metadata, "colorLight");
			item.colorDark = metadataString(metadata, "colorDark");
			break;
		}
		case "multiPinMap":
		case "genericMap": {
			const visits = visitTemplateItems(metadata);
			item.visits = visits;
			item.title = visits
				.map((visit) => visit.placeName || visit.city)
				.filter(Boolean)
				.join(", ");
			break;
		}
		case "motionActivity": {
			const activityName = metadataString(metadata, "localizedActivityName");
			item.title = activityName;
			item.activity = metadataString(metadata, "activityType");
			item.activityName = activityName;
			item.steps = numericOrString(metadataString(metadata, "steps"));
			break;
		}
		case "photo":
		case "video":
		case "livePhoto": {
			item.assetIdentifier = metadataString(metadata, "assetIdentifier");
			item.takenAt = appleEpochToISO(metadataNumber(metadata, "date"));
			item.placeName = metadataString(metadata, "placeName");
			break;
		}
		default:
			break;
	}
	return item;
}

interface VisitTemplateItem extends Record<string, unknown> {
	city: string;
	placeName: string;
}

function visitTemplateItems(metadata: Record<string, unknown>): VisitTemplateItem[] {
	const raw = metadata.visitsData;
	// multiPinMap stores an array of visits; genericMap stores one object.
	const visits = Array.isArray(raw) ? raw : raw ? [raw] : [];
	return visits
		.filter((visit): visit is Record<string, unknown> => typeof visit === "object" && visit !== null)
		.map((visit) => ({
			city: metadataString(visit, "city"),
			placeName: metadataString(visit, "placeName"),
			latitude: metadataNumber(visit, "latitude") ?? null,
			longitude: metadataNumber(visit, "longitude") ?? null,
			isWork: visit.isWork === true,
			date: appleEpochToISO(metadataNumber(visit, "visitStartTime") ?? metadataNumber(visit, "createdDate")),
			endDate: appleEpochToISO(metadataNumber(visit, "visitEndTime")),
		}));
}

function metadataString(metadata: Record<string, unknown>, key: string): string {
	const value = metadata[key];
	if (typeof value === "string") {
		return value;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}
	return "";
}

function metadataNumber(metadata: Record<string, unknown>, key: string): number | undefined {
	const value = metadata[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function musicTemplateItems(attachments: JournalMusicAttachment[]): Record<string, unknown>[] {
	return attachments
		.filter((attachment) => attachment.song.trim())
		.map((attachment) => ({
			uuid: attachment.id,
			id: attachment.id,
			type: "music",
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

function photoTemplateItems(
	attachments: JournalPhotoAttachment[],
	photoFiles: Record<string, string>
): Record<string, unknown>[] {
	return attachments
		.filter((attachment) => attachment.id)
		.map((attachment) => {
			const files = (attachment.files ?? []).map(photoTemplateFile);
			const primary = files.find((file) => file.name === "image") ?? files[0];
			// Prefer the converted file Markway downloaded into the vault, so
			// templates link to files that actually exist for Obsidian.
			const vaultPath = photoFiles[attachment.id];
			const fileName = vaultPath ? lastPathComponent(vaultPath) : primary?.fileName ?? "";
			return {
				uuid: attachment.id,
				id: attachment.id,
				type: attachment.assetType ?? "photo",
				assetType: attachment.assetType ?? "photo",
				source: attachment.source ?? "",
				flags: {
					hidden: attachment.isHidden === true,
					slim: attachment.isSlim === true,
				},
				title: fileName,
				assetIdentifier: attachment.assetIdentifier ?? "",
				takenAt: appleEpochToISO(attachment.assetDate),
				created: attachment.createdDate ?? "",
				suggestionDate: attachment.suggestionDate ?? "",
				fileName,
				path: vaultPath ?? primary?.path ?? "",
				relativePath: primary?.relativePath ?? "",
				absolutePath: primary?.absolutePath ?? "",
				files,
			};
		});
}

interface PhotoTemplateFile extends Record<string, unknown> {
	name: string;
	fileName: string;
	path: string;
	relativePath: string;
	absolutePath: string;
}

function photoTemplateFile(file: JournalAttachmentFile): PhotoTemplateFile {
	const relativePath = file.relativePath ?? "";
	const absolutePath = file.absolutePath ?? "";
	return {
		id: file.id,
		name: file.name ?? "",
		fileName: lastPathComponent(relativePath || absolutePath),
		path: absolutePath,
		relativePath,
		absolutePath,
		exists: file.exists === true,
		byteLength: file.byteLength ?? null,
	};
}

function lastPathComponent(path: string): string {
	const parts = path.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? "";
}

// Journal stores photo capture dates as seconds since the Apple reference date (2001-01-01 UTC).
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

function appleEpochToISO(seconds: number | undefined): string {
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
		return "";
	}
	return new Date(APPLE_EPOCH_MS + seconds * 1000).toISOString();
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
