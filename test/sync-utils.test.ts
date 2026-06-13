import { describe, expect, it } from "vitest";
import {
	DEFAULT_JOURNAL_FOLDER,
	DEFAULT_JOURNAL_PROPERTIES,
	canSkipJournalEntryForSummary,
	composeMarkdown,
	defaultMarkwaySettings,
	describeUnknown,
	explainMarkwayError,
	frontmatterComparableValues,
	hashJournalContent,
	hasMarkdownChangedSinceLastSync,
	hasMatchingJournalSummary,
	hasUnsyncedMarkdownContent,
	isFileExistsError,
	mergeSyncOptions,
	normalizeDebounceMs,
	normalizeFolder,
	normalizeJournalProperties,
	normalizePath,
	normalizeTemplatePropertyKey,
	preserveMarkdownStructure,
	readJournalLinks,
	readPluginData,
	readSettings,
	addedFrontmatterValues,
	removedGeneratedAttachmentIDs,
	sameVaultPath,
	safePathSegments,
	sanitizeFileName,
	sha256Hex,
	splitMarkdown,
	stringValue,
	titleForFile,
	vaultPathKey,
} from "../src/sync-utils";

describe("settings defaults and parsing", () => {
	it("uses Journal as the default import folder fallback", () => {
		expect(DEFAULT_JOURNAL_FOLDER).toBe("Journal");
	});

	it("creates default settings with automatic sync enabled", () => {
		expect(defaultMarkwaySettings().automaticSync).toBe(true);
	});

	it("keeps first-install sync setup incomplete by default", () => {
		expect(defaultMarkwaySettings().syncSetupComplete).toBe(false);
	});

	it("keeps delete propagation disabled by default", () => {
		const settings = defaultMarkwaySettings();
		expect(settings.deleteJournalEntryWhenFileDeleted).toBe(false);
		expect(settings.deleteMarkdownFileWhenJournalDeleted).toBe(false);
	});

	it("creates a default music property template", () => {
		const settings = defaultMarkwaySettings();
		expect(settings.journalProperties).toEqual(DEFAULT_JOURNAL_PROPERTIES);
		expect(settings.journalIncludeTitleHeading).toBe(false);
	});

	it("creates default rules for a custom folder", () => {
		expect(defaultMarkwaySettings("Diary").journalRules.conditions[0]).toMatchObject({
			field: "file.folder",
			operator: "is",
			value: "Diary",
		});
	});

	it("returns defaults for invalid plugin data", () => {
		const data = readPluginData(null);
		expect(data.settings.journalFolder).toBe("Journal");
		expect(data.settings.syncSetupComplete).toBe(false);
	});

	it("reads nested plugin data", () => {
		const data = readPluginData({ settings: { automaticSync: false, journalFolder: "Diary" }, journalLinks: {} });
		expect(data.settings.automaticSync).toBe(false);
		expect(data.settings.journalFolder).toBe("Diary");
		expect(data.settings.syncSetupComplete).toBe(true);
	});

	it("preserves explicit sync setup state", () => {
		expect(readPluginData({ settings: { syncSetupComplete: false }, journalLinks: {} }).settings.syncSetupComplete)
			.toBe(false);
		expect(readPluginData({ settings: { syncSetupComplete: true }, journalLinks: {} }).settings.syncSetupComplete)
			.toBe(true);
	});

	it("keeps legacy flat settings compatible", () => {
		const data = readPluginData({ autoScan: true, debounceMs: 500, vaultPathOverride: " /tmp/vault " });
		expect(data.settings.automaticSync).toBe(true);
		expect(data.settings.syncSetupComplete).toBe(true);
		expect(data.settings.debounceMs).toBe(500);
		expect(data.settings.vaultPathOverride).toBe("/tmp/vault");
	});

	it("uses custom import folder fallback for default rules when rules are missing", () => {
		const data = readPluginData({ settings: { journalFolder: "Diary" }, journalLinks: {} });
		expect(data.settings.journalRules.conditions[0]).toMatchObject({ value: "Diary" });
	});

	it("parses explicit journal rules", () => {
		const data = readPluginData({
			settings: {
				journalRules: {
					type: "group",
					operator: "OR",
					conditions: [{ type: "filter", field: "file.name", operator: "contains", value: "Daily" }],
				},
			},
		});
		expect(data.settings.journalRules.operator).toBe("OR");
		expect(data.settings.journalRules.conditions[0]).toMatchObject({ field: "file.name" });
	});

	it("reads partial settings", () => {
		expect(readSettings({
			debounceMs: "900",
			journalFolder: "/Journal/",
			deleteJournalEntryWhenFileDeleted: true,
			deleteMarkdownFileWhenJournalDeleted: true,
		})).toMatchObject({
			debounceMs: 900,
			journalFolder: "Journal",
			deleteJournalEntryWhenFileDeleted: true,
			deleteMarkdownFileWhenJournalDeleted: true,
		});
	});

	it("reads journal property templates", () => {
		expect(readSettings({
			journalProperties: [{ id: "p1", key: " songs ", value: "{{music}}" }],
			journalIncludeTitleHeading: true,
		})).toMatchObject({
			journalProperties: [{ id: "p1", key: "songs", value: "{{music}}" }],
			journalIncludeTitleHeading: true,
		});
	});

	it("migrates legacy music fields to a property template", () => {
		expect(readSettings({ musicField: " songs " }).journalProperties).toEqual([
			{ id: "music", key: "songs", value: "{{music|map:item => item.title|wikilink}}" },
		]);
	});

	it("normalizes template property keys", () => {
		expect(normalizeTemplatePropertyKey(" music ")).toBe("music");
	});

	it("normalizes invalid journal properties to the default", () => {
		expect(normalizeJournalProperties(null)).toEqual(DEFAULT_JOURNAL_PROPERTIES);
	});

	it.each([
		[1200, 1200],
		["450", 450],
		[100, 250],
		["bad", 1200],
	] as const)("normalizes debounce %s", (input, expected) => {
		expect(normalizeDebounceMs(input)).toBe(expected);
	});
});

describe("journal links", () => {
	it("ignores invalid link data", () => {
		expect(readJournalLinks(null)).toEqual({});
	});

	it("ignores links without paths", () => {
		expect(readJournalLinks({ A: { journalID: "A" } })).toEqual({});
	});

	it("ignores links without journal IDs", () => {
		expect(readJournalLinks({ " ": { journalID: " ", path: "Journal/Entry.md" } })).toEqual({});
	});

	it("normalizes link records", () => {
		const links = readJournalLinks({
			A: {
				path: "Journal//Entry.md",
				title: "",
				lastSyncedAt: "now",
				lastMarkdownHash: "m",
				lastJournalHash: "j",
				lastJournalUpdated: "u",
			},
		});
		expect(links.A).toMatchObject({
			journalID: "A",
			path: "Journal/Entry.md",
			title: "Entry",
			lastSyncedAt: "now",
			lastMarkdownHash: "m",
			lastJournalHash: "j",
			lastJournalUpdated: "u",
			lastTemplateHash: "",
			lastTemplateSettingsHash: "",
			lastTemplatePropertyKeys: [],
			lastTemplateProperties: {},
			lastAttachmentPropertyItems: {},
		});
	});

	it("prefers embedded journal IDs", () => {
		const links = readJournalLinks({ A: { journalID: "B", path: "Journal/Entry.md" } });
		expect(links.B?.journalID).toBe("B");
	});

	it("matches journal summaries by updated date and title", () => {
		const link = {
			journalID: "A",
			path: "A.md",
			title: "Title",
			lastSyncedAt: "",
			lastMarkdownHash: "",
			lastJournalHash: "",
			lastJournalUpdated: "u",
			lastTemplateHash: "",
			lastTemplateSettingsHash: "",
			lastTemplatePropertyKeys: [],
			lastTemplateProperties: {},
			lastAttachmentPropertyItems: {},
			lastContentPrefix: "",
			lastContentSuffix: "",
			lastBodySections: [],
			lastPhotoFiles: {},
		};
		const summary = { id: "A", status: "active", created: "", updated: "u", title: "Title" };
		expect(hasMatchingJournalSummary(
			link,
			summary
		)).toBe(true);
		expect(canSkipJournalEntryForSummary(
			link,
			summary,
			{ templateNeedsRefresh: false, metadataNeedsRefresh: false }
		)).toBe(true);
	});

	it("does not skip matching summaries when template metadata needs refresh", () => {
		const link = {
			journalID: "A",
			path: "A.md",
			title: "Title",
			lastSyncedAt: "",
			lastMarkdownHash: "",
			lastJournalHash: "",
			lastJournalUpdated: "u",
			lastTemplateHash: "",
			lastTemplateSettingsHash: "",
			lastTemplatePropertyKeys: [],
			lastTemplateProperties: {},
			lastAttachmentPropertyItems: {},
			lastContentPrefix: "",
			lastContentSuffix: "",
			lastBodySections: [],
			lastPhotoFiles: {},
		};
		expect(canSkipJournalEntryForSummary(
			link,
			{ id: "A", status: "active", created: "", updated: "u", title: "Title" },
			{ templateNeedsRefresh: false, metadataNeedsRefresh: true }
		)).toBe(false);
	});

	it("does not match summaries without updated dates", () => {
		expect(hasMatchingJournalSummary(
			{
				journalID: "A",
				path: "A.md",
				title: "Title",
				lastSyncedAt: "",
				lastMarkdownHash: "",
				lastJournalHash: "",
				lastJournalUpdated: "",
					lastTemplateHash: "",
					lastTemplateSettingsHash: "",
					lastTemplatePropertyKeys: [],
					lastTemplateProperties: {},
					lastAttachmentPropertyItems: {},
					lastContentPrefix: "",
					lastContentSuffix: "",
					lastBodySections: [],
					lastPhotoFiles: {},
				},
			{ id: "A", status: "active", created: "", title: "Title" }
		)).toBe(false);
	});
});

describe("markdown parsing", () => {
	it("splits markdown without frontmatter", () => {
		expect(splitMarkdown("Body")).toEqual({ frontmatter: null, body: "Body" });
	});

	it("splits markdown with frontmatter", () => {
		expect(splitMarkdown("---\na: b\n---\nBody")).toEqual({ frontmatter: "---\na: b\n---\n", body: "Body" });
	});

	it("normalizes CRLF before splitting", () => {
		expect(splitMarkdown("---\r\na: b\r\n---\r\nBody").frontmatter).toBe("---\na: b\n---\n");
	});

	it("keeps malformed frontmatter as body", () => {
		expect(splitMarkdown("---\na: b\nBody")).toEqual({ frontmatter: null, body: "---\na: b\nBody" });
	});

	it("composes markdown without frontmatter", () => {
		expect(composeMarkdown(null, "Body")).toBe("Body");
	});

	it("composes markdown with frontmatter", () => {
		expect(composeMarkdown("---\na: b\n---\n", "Body")).toBe("---\na: b\n---\nBody");
	});

	it("hashes title and body together", () => {
		expect(hashJournalContent("A", "B")).toBe(sha256Hex("A\0B"));
	});

	it("uses different hashes for different titles", () => {
		expect(hashJournalContent("A", "B")).not.toBe(hashJournalContent("C", "B"));
	});
});

describe("markdown structure preservation", () => {
	it("reapplies existing markdown wrappers when Journal normalizes paragraph attributes", () => {
		const existing = [
			"ui maa **bold** *italic*",
			"",
			"## ok",
			"",
			"- item 1",
			"",
			"1. two",
			"1. three",
			"1. four",
			"",
			"```",
			"const ok = \"strong\"",
			"```",
			"",
			"> Take me back to the night we met",
			"",
			"--------",
		].join("\n");
		const journal = [
			"ui maa **bold** *italic*",
			"",
			"**okidoki**",
			"",
			"- item 1",
			"",
			"1. two",
			"1. three",
			"1. four",
			"",
			"const ok = \"strong\"",
			"",
			"Take me back to the night we met",
		].join("\n");

		expect(preserveMarkdownStructure(existing, journal)).toBe([
			"ui maa **bold** *italic*",
			"",
			"## okidoki",
			"",
			"- item 1",
			"",
			"1. two",
			"1. three",
			"1. four",
			"",
			"```",
			"const ok = \"strong\"",
			"```",
			"",
			"> Take me back to the night we met",
			"",
			"--------",
		].join("\n"));
	});

	it("keeps a fenced code language from the existing note", () => {
		expect(preserveMarkdownStructure("```js\nconst ok = 1\n```", "const ok = 2")).toBe("```js\nconst ok = 2\n```");
	});

	it("preserves quote markers when only quote text changes", () => {
		expect(preserveMarkdownStructure("> old quote", "new quote")).toBe("> new quote");
	});

	it("leaves new notes untouched when there is no existing structure", () => {
		expect(preserveMarkdownStructure("", "**bold**\n\nPlain")).toBe("**bold**\n\nPlain");
	});

	it("does not preserve stale extra trailing blank lines from the existing note", () => {
		expect(preserveMarkdownStructure("Body\n\n\n\n\n", "Body\n")).toBe("Body\n");
	});

	it("preserves trailing blank lines when they are present in the journal body", () => {
		expect(preserveMarkdownStructure("Body\n", "Body\n\n\n")).toBe("Body\n\n\n");
	});
});

describe("paths and file names", () => {
	it.each([
		["Journal//Entry.md", "Journal/Entry.md"],
		["Journal\\Entry.md", "Journal/Entry.md"],
		["Journal/", "Journal"],
	] as const)("normalizes path %s", (input, expected) => {
		expect(normalizePath(input)).toBe(expected);
	});

	it.each([
		[" /Journal/ ", "Journal"],
		["Journal/Sub/", "Journal/Sub"],
		["../Journal/./Trips", "Journal/Trips"],
		["..", ""],
		["", ""],
	] as const)("normalizes folder %s", (input, expected) => {
		expect(normalizeFolder(input)).toBe(expected);
	});

	it("drops unsafe path segments", () => {
		expect(safePathSegments("Journal/../Trips/./Entry")).toEqual(["Journal", "Trips", "Entry"]);
	});

	it("builds title from a markdown path", () => {
		expect(titleForFile("Journal/My Entry.md")).toBe("My Entry");
	});

	it("falls back for empty titles", () => {
		expect(titleForFile("")).toBe("Journal Entry");
	});

	it("removes unsafe filename separators", () => {
		expect(sanitizeFileName("A/B\\C:D")).toBe("A-B-C-D");
	});

	it("collapses filename whitespace", () => {
		expect(sanitizeFileName(" A   B ")).toBe("A B");
	});

	it("removes control characters from filenames", () => {
		expect(sanitizeFileName("A\u0000B")).toBe("AB");
	});

	it("limits long filenames", () => {
		expect(sanitizeFileName("a".repeat(300))).toHaveLength(180);
	});

	it("creates case-insensitive path keys", () => {
		expect(vaultPathKey("Journal/Entry.md")).toBe("journal/entry.md");
	});

	it("compares equal vault paths", () => {
		expect(sameVaultPath("Journal/Entry.md", "journal/entry.md")).toBe(true);
	});

	it("does not compare missing vault paths", () => {
		expect(sameVaultPath("Journal/Entry.md")).toBe(false);
	});
});

describe("generated attachment frontmatter", () => {
	const generated = [
		{ id: "A", value: "[[Sahiba]]" },
		{ id: "B", value: "[[How do you know]]" },
		{ id: "C", value: "[[Cornfield Chase]]" },
	];

	it("normalizes scalar and array frontmatter values for comparisons", () => {
		expect(frontmatterComparableValues("[[Sahiba]]")).toEqual(["[[Sahiba]]"]);
		expect(frontmatterComparableValues([" [[Sahiba]] ", "[[Cornfield Chase]]"])).toEqual([
			"[[Sahiba]]",
			"[[Cornfield Chase]]",
		]);
		expect(frontmatterComparableValues(new Date("2026-06-05T01:02:03Z"))).toEqual(["2026-06-05T01:02:03.000Z"]);
	});

	it("detects a simple removal from generated frontmatter", () => {
		expect(removedGeneratedAttachmentIDs(generated, ["[[Sahiba]]", "[[Cornfield Chase]]"])).toEqual(["B"]);
	});

	it("does not delete when a generated music item is edited in place", () => {
		expect(removedGeneratedAttachmentIDs(generated, [
			"[[Sahiba]]",
			"[[How do you know - alternate name]]",
			"[[Cornfield Chase]]",
		])).toEqual([]);
	});

	it("does not delete when a new music-looking value is added", () => {
		expect(removedGeneratedAttachmentIDs(generated, [
			"[[Sahiba]]",
			"[[How do you know]]",
			"[[Cornfield Chase]]",
			"[[New song]]",
		])).toEqual([]);
	});

	it("does not delete when removal is mixed with an edit", () => {
		expect(removedGeneratedAttachmentIDs(generated, ["[[Sahiba alt]]", "[[Cornfield Chase]]"])).toEqual([]);
	});

	it("does not delete ambiguous duplicate generated values", () => {
		expect(removedGeneratedAttachmentIDs([
			{ id: "A", value: "[[Same]]" },
			{ id: "B", value: "[[Same]]" },
		], ["[[Same]]"])).toEqual([]);
	});

	it("reads legacy music property items into attachment property items", () => {
		const links = readJournalLinks({
			A: {
				path: "Journal/Entry.md",
				lastMusicPropertyItems: {
					music: [{ id: "MUSIC-ID", value: "[[Sahiba]]" }],
				},
			},
		});
		expect(links.A?.lastAttachmentPropertyItems).toEqual({
			music: [{ id: "MUSIC-ID", value: "[[Sahiba]]" }],
		});
	});

	it("prefers current attachment property items over legacy music items", () => {
		const links = readJournalLinks({
			A: {
				path: "Journal/Entry.md",
				lastAttachmentPropertyItems: {
					photos: [{ id: "PHOTO-ID", value: "[[photo.heic]]" }],
				},
				lastMusicPropertyItems: {
					music: [{ id: "MUSIC-ID", value: "[[Sahiba]]" }],
				},
			},
		});
		expect(links.A?.lastAttachmentPropertyItems).toEqual({
			photos: [{ id: "PHOTO-ID", value: "[[photo.heic]]" }],
		});
	});
});

describe("generated photo frontmatter", () => {
	const generated = [
		{ id: "C0CA3030", value: "[[5D52141E_resized.heic]]" },
		{ id: "CA952F27", value: "[[AE5E6288_resized.heic]]" },
		{ id: "8D981B70", value: "[[0CC3C63D_resized.heic]]" },
	];

	it("detects a simple removal from generated photo frontmatter", () => {
		expect(removedGeneratedAttachmentIDs(generated, [
			"[[5D52141E_resized.heic]]",
			"[[0CC3C63D_resized.heic]]",
		])).toEqual(["CA952F27"]);
	});

	it("does not delete when a generated photo item is edited in place", () => {
		expect(removedGeneratedAttachmentIDs(generated, [
			"[[5D52141E_resized.heic]]",
			"[[AE5E6288_resized.heic|Beach]]",
			"[[0CC3C63D_resized.heic]]",
		])).toEqual([]);
	});

	it("does not delete when a new photo-looking value is added", () => {
		expect(removedGeneratedAttachmentIDs(generated, [
			"[[5D52141E_resized.heic]]",
			"[[AE5E6288_resized.heic]]",
			"[[0CC3C63D_resized.heic]]",
			"[[New photo.heic]]",
		])).toEqual([]);
	});

	it("does not delete when a photo removal is mixed with an edit", () => {
		expect(removedGeneratedAttachmentIDs(generated, [
			"[[5D52141E_resized edited.heic]]",
			"[[0CC3C63D_resized.heic]]",
		])).toEqual([]);
	});

	it("does not delete ambiguous duplicate generated photo values", () => {
		expect(removedGeneratedAttachmentIDs([
			{ id: "A", value: "[[Same.heic]]" },
			{ id: "B", value: "[[Same.heic]]" },
		], ["[[Same.heic]]"])).toEqual([]);
	});

	it("detects values added to a generated photo property", () => {
		expect(addedFrontmatterValues(generated, [
			"[[5D52141E_resized.heic]]",
			"[[AE5E6288_resized.heic]]",
			"[[0CC3C63D_resized.heic]]",
			"[[Sunset.png]]",
		])).toEqual(["[[Sunset.png]]"]);
	});

	it("reports no additions for unchanged generated values", () => {
		expect(addedFrontmatterValues(generated, [
			"[[5D52141E_resized.heic]]",
			"[[AE5E6288_resized.heic]]",
			"[[0CC3C63D_resized.heic]]",
		])).toEqual([]);
	});

	it("treats duplicated generated values as additions", () => {
		expect(addedFrontmatterValues([
			{ id: "A", value: "[[Same.heic]]" },
		], ["[[Same.heic]]", "[[Same.heic]]"])).toEqual(["[[Same.heic]]"]);
	});

	it("reports additions even when another value was removed", () => {
		expect(addedFrontmatterValues(generated, [
			"[[5D52141E_resized.heic]]",
			"[[New.png]]",
		])).toEqual(["[[New.png]]"]);
	});

	it("reads the photos property setting", () => {
		expect(readSettings({ journalPhotosProperty: " photos " })).toMatchObject({
			journalPhotosProperty: "photos",
		});
	});

	it("reads the created property setting", () => {
		expect(readSettings({ journalCreatedProperty: " created_at " })).toMatchObject({
			journalCreatedProperty: "created_at",
		});
	});

	it("reads stored photo file mappings", () => {
		const links = readJournalLinks({
			A: {
				path: "Journal/Entry.md",
				lastPhotoFiles: { "PHOTO-ID": "Attachments/Trip - 1.heic", BAD: 7 },
				lastContentPrefix: "Photos: 2\n\n",
				lastContentSuffix: "\n---",
			},
		});
		expect(links.A?.lastPhotoFiles).toEqual({ "PHOTO-ID": "Attachments/Trip - 1.heic" });
		expect(links.A?.lastContentPrefix).toBe("Photos: 2\n\n");
		expect(links.A?.lastContentSuffix).toBe("\n---");
	});
});

describe("sync decisions and errors", () => {
	function linkWithMarkdownHash(lastMarkdownHash: string) {
		return {
			journalID: "A",
			path: "Journal/A.md",
			title: "A",
			lastSyncedAt: "",
			lastMarkdownHash,
			lastJournalHash: "",
			lastJournalUpdated: "",
			lastTemplateHash: "",
			lastTemplateSettingsHash: "",
			lastTemplatePropertyKeys: [],
			lastTemplateProperties: {},
			lastAttachmentPropertyItems: {},
			lastContentPrefix: "",
			lastContentSuffix: "",
			lastBodySections: [],
			lastPhotoFiles: {},
		};
	}

	it("treats a changed markdown hash as local work that automatic pull must not overwrite", () => {
		expect(hasMarkdownChangedSinceLastSync(
			linkWithMarkdownHash(sha256Hex("old")),
			"new"
		)).toBe(true);
	});

	it("does not mark markdown changed when the saved hash still matches", () => {
		expect(hasMarkdownChangedSinceLastSync(
			linkWithMarkdownHash(sha256Hex("same")),
			"same"
		)).toBe(false);
	});

	it("does not block old links that never recorded a markdown hash", () => {
		expect(hasMarkdownChangedSinceLastSync(linkWithMarkdownHash(""), "body")).toBe(false);
	});

	it("trusts a matching markdown hash even when preserved markdown differs from Journal plain text", () => {
		const markdown = "## boka\n\n```js\nok = doki\n```\n";
		const link = {
			...linkWithMarkdownHash(sha256Hex(markdown)),
			lastJournalHash: hashJournalContent("Into the night", "boka\n\nok = doki\n"),
		};

		expect(hasUnsyncedMarkdownContent(
			link,
			markdown,
			"Into the night",
			markdown
		)).toBe(false);
	});

	it("uses Journal hashes for legacy links without a markdown hash", () => {
		const markdown = "Changed";
		const title = "Entry";
		const link = {
			...linkWithMarkdownHash(""),
			lastJournalHash: hashJournalContent(title, "Previous"),
		};

		expect(hasUnsyncedMarkdownContent(link, markdown, title, markdown)).toBe(true);
	});

	it("merges sync options when no existing options are queued", () => {
		expect(mergeSyncOptions(null, { includeNew: true })).toEqual({ includeNew: true });
	});

	it("preserves includeNew if either queued request needs it", () => {
		expect(mergeSyncOptions({ includeNew: false }, { includeNew: true }).includeNew).toBe(true);
	});

	it("keeps silent true only when both queued requests are silent", () => {
		expect(mergeSyncOptions({ includeNew: false, silent: true }, { includeNew: false, silent: false }).silent).toBe(false);
	});

	it("preserves frontmatter migration if either queued request needs it", () => {
		expect(mergeSyncOptions({ includeNew: false }, { includeNew: false, migrateFrontmatter: true }).migrateFrontmatter).toBe(true);
	});

	it("detects file exists messages", () => {
		expect(isFileExistsError(new Error("File already exists"))).toBe(true);
	});

	it("detects eexist messages", () => {
		expect(isFileExistsError(new Error("EEXIST: path"))).toBe(true);
	});

	it("ignores unrelated errors", () => {
		expect(isFileExistsError(new Error("permission denied"))).toBe(false);
	});

	it("describes Error instances", () => {
		expect(describeUnknown(new Error("boom"))).toBe("boom");
	});

	it("describes strings", () => {
		expect(describeUnknown("boom")).toBe("boom");
	});

	it("describes serializable values", () => {
		expect(describeUnknown({ ok: true })).toBe("{\"ok\":true}");
	});

	it("explains Apple Journal privacy failures", () => {
		expect(explainMarkwayError(new Error("group.com.apple.moments denied"))).toContain("Full Disk Access");
	});

	it("passes through ordinary errors", () => {
		expect(explainMarkwayError(new Error("ordinary"))).toBe("ordinary");
	});

	it("trims string values", () => {
		expect(stringValue("  ok  ")).toBe("ok");
	});

	it("returns empty strings for non-string values", () => {
		expect(stringValue(123)).toBe("");
	});
});
