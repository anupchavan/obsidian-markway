import type { FilterGroup } from "../rules";

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
	journalNoteNameTemplate: string;
	journalContentTemplate: string;
	journalPhotosProperty: string;
	journalCreatedProperty: string;
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
	lastJournalCreated?: string;
	lastMarkdownHash: string;
	lastJournalHash: string;
	lastJournalUpdated: string;
	lastTemplateHash: string;
	lastTemplateSettingsHash: string;
	lastTemplatePropertyKeys: string[];
	lastTemplateProperties: Record<string, unknown>;
	lastAttachmentPropertyItems: Record<string, GeneratedAttachmentPropertyItem[]>;
	lastContentPrefix: string;
	lastContentSuffix: string;
	lastBodySections: JournalBodySection[];
	lastPhotoFiles: Record<string, string>;
}

/// One region of a synced note body. Generated sections hold the text Markway
/// last rendered for them; the content section's text is tracked through
/// lastJournalHash instead and stays empty here.
export interface JournalBodySection {
	kind: "generated" | "content";
	marker: string;
	text: string;
}

export interface GeneratedAttachmentPropertyItem {
	id: string;
	value: string;
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
	photoAttachments?: JournalPhotoAttachment[];
	attachments?: JournalGenericAttachment[];
}

export interface JournalGenericAttachment {
	id: string;
	assetType: string;
	source?: string;
	isHidden?: boolean;
	isSlim?: boolean;
	createdDate?: string;
	suggestionDate?: string;
	files?: JournalAttachmentFile[];
	metadata?: Record<string, unknown>;
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

export interface JournalPhotoAttachment {
	id: string;
	assetType?: string;
	source?: string;
	isHidden?: boolean;
	isSlim?: boolean;
	assetIdentifier?: string;
	assetDate?: number;
	createdDate?: string;
	suggestionDate?: string;
	files?: JournalAttachmentFile[];
}

export interface JournalAttachmentFile {
	id: string;
	name?: string;
	relativePath?: string;
	absolutePath?: string;
	exists?: boolean;
	byteLength?: number;
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
