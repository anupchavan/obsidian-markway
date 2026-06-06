import { describe, expect, it } from "vitest";
import {
	DEFAULT_JOURNAL_FOLDER,
	DEFAULT_JOURNAL_PROPERTIES,
	composeMarkdown,
	defaultMarkwaySettings,
	describeUnknown,
	explainMarkwayError,
	hashJournalContent,
	hasMatchingJournalSummary,
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
	sameVaultPath,
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
		expect(readPluginData(null).settings.journalFolder).toBe("Journal");
	});

	it("reads nested plugin data", () => {
		const data = readPluginData({ settings: { automaticSync: false, journalFolder: "Diary" }, journalLinks: {} });
		expect(data.settings.automaticSync).toBe(false);
		expect(data.settings.journalFolder).toBe("Diary");
	});

	it("keeps legacy flat settings compatible", () => {
		const data = readPluginData({ autoScan: true, debounceMs: 500, vaultPathOverride: " /tmp/vault " });
		expect(data.settings.automaticSync).toBe(true);
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
		});
	});

	it("prefers embedded journal IDs", () => {
		const links = readJournalLinks({ A: { journalID: "B", path: "Journal/Entry.md" } });
		expect(links.B?.journalID).toBe("B");
	});

	it("matches journal summaries by updated date and title", () => {
		expect(hasMatchingJournalSummary(
			{
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
			},
			{ id: "A", status: "active", created: "", updated: "u", title: "Title" }
		)).toBe(true);
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
		["", ""],
	] as const)("normalizes folder %s", (input, expected) => {
		expect(normalizeFolder(input)).toBe(expected);
	});

	it("builds title from a markdown path", () => {
		expect(titleForFile("Journal/My Entry.md")).toBe("My Entry");
	});

	it("falls back for empty titles", () => {
		expect(titleForFile("")).toBe("Journal Entry");
	});

	it("removes unsafe filename separators", () => {
		expect(sanitizeFileName("A/B:C")).toBe("A-B-C");
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

describe("sync decisions and errors", () => {
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
