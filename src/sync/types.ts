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
	lastTemplateProperties: Record<string, unknown>;
	lastMusicPropertyItems: Record<string, GeneratedMusicPropertyItem[]>;
}

export interface GeneratedMusicPropertyItem {
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
