import { describe, expect, it } from "vitest";
import {
	journalTemplateNeedsMusic,
	journalTemplateSettingsHash,
	renderJournalBody,
	renderJournalTemplateProperties,
	stripGeneratedTitleHeading,
	validateTemplateVariables,
} from "../src/journal-template";
import { defaultMarkwaySettings, type JournalEntryText, type MarkwaySettings } from "../src/sync-utils";

const entry: JournalEntryText = {
	id: "ENTRY-ID",
	title: "Flexoki",
	body: "Body",
	created: "2026-06-05T01:02:03Z",
	updated: "2026-06-06T01:02:03Z",
	musicAttachments: [
		{
			id: "134D4F26-4E2C-414D-8F6F-C0D4274E7F66",
			song: "Sahiba / (Original Motion Picture Soundtrack)",
			artistName: "Shashwat Sachdev, Pawni Pandey & Romy",
			mediaId: "1212020454",
			source: "suggestionSheet",
			isHidden: false,
			isSlim: true,
			mediaType: "song",
			startTime: 801651989.753966,
		},
		{
			id: "3E161BEF-A5EF-4BFF-A229-0D7E2AF315E5",
			song: "How do you know",
			artistName: "Karthik Rao",
			mediaId: "6762845458",
			source: "suggestionSheet",
			isHidden: false,
			isSlim: false,
		},
	],
};

function settingsWith(properties: MarkwaySettings["journalProperties"]): MarkwaySettings {
	return {
		...defaultMarkwaySettings(),
		journalProperties: properties,
	};
}

describe("journal templates", () => {
	it("detects music variables in configured properties", () => {
		expect(journalTemplateNeedsMusic(defaultMarkwaySettings())).toBe(true);
	});

	it("does not need music when no property references music", () => {
		expect(journalTemplateNeedsMusic(settingsWith([{ id: "title", key: "title", value: "{{title}}" }]))).toBe(false);
	});

	it("renders the default music property as wikilink array frontmatter", () => {
		const rendered = renderJournalTemplateProperties(entry, defaultMarkwaySettings());
		expect(rendered.properties.music).toEqual([
			"[[Sahiba / (Original Motion Picture Soundtrack)]]",
			"[[How do you know]]",
		]);
		expect(rendered.musicPropertyItems.music).toEqual([
			{
				id: "134D4F26-4E2C-414D-8F6F-C0D4274E7F66",
				value: "[[Sahiba / (Original Motion Picture Soundtrack)]]",
			},
			{
				id: "3E161BEF-A5EF-4BFF-A229-0D7E2AF315E5",
				value: "[[How do you know]]",
			},
		]);
	});

	it("renders the provided map replace wikilink example", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{
				id: "music",
				key: "music",
				value: "{{music|map:item => item.title|replace:\"/ \\(Original Motion Picture Soundtrack\\)/g\": \"\"|wikilink}}",
			},
		]));
		expect(rendered.properties.music).toEqual(["[[Sahiba /]]", "[[How do you know]]"]);
	});

	it("exposes music uuids through map", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "music-ids", key: "music_ids", value: "{{music|map:item => item.uuid}}" },
		]));
		expect(rendered.properties.music_ids).toEqual([
			"134D4F26-4E2C-414D-8F6F-C0D4274E7F66",
			"3E161BEF-A5EF-4BFF-A229-0D7E2AF315E5",
		]);
	});

	it("exposes artist arrays through music", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "artists", key: "artists", value: "{{music|map:item => item.artists[0]}}" },
		]));
		expect(rendered.properties.artists).toEqual(["Shashwat Sachdev", "Karthik Rao"]);
	});

	it("exposes media ids as numbers when safe", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "media", key: "media", value: "{{music|map:item => item.mediaId}}" },
		]));
		expect(rendered.properties.media).toEqual([1212020454, 6762845458]);
	});

	it("renders scalar title properties", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "title", key: "journal_title", value: "{{title}}" },
		]));
		expect(rendered.properties.journal_title).toBe("Flexoki");
	});

	it("renders created and modified variables", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "created", key: "created", value: "{{created}}" },
			{ id: "modified", key: "last", value: "{{modified}}" },
		]));
		expect(rendered.properties.created).toBe("2026-06-05T01:02:03Z");
		expect(rendered.properties.last).toBe("2026-06-06T01:02:03Z");
	});

	it("formats created dates", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "created", key: "created", value: "{{created|date:\"YYYY-MM-DD\"}}" },
		]));
		expect(rendered.properties.created).toBe("2026-06-05");
	});

	it("renders content variables", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "content", key: "body_copy", value: "{{content}}" },
		]));
		expect(rendered.properties.body_copy).toBe("Body");
	});

	it("supports trim and upper filters", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "title", key: "title", value: "  {{title|upper|trim}}  " },
		]));
		expect(rendered.properties.title).toBe("  FLEXOKI  ");
	});

	it("supports join after map", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "joined", key: "joined", value: "{{music|map:item => item.title|join:\", \"}}" },
		]));
		expect(rendered.properties.joined).toContain("Sahiba");
		expect(rendered.properties.joined).toContain("How do you know");
	});

	it("reports unknown variables", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "bad", key: "bad", value: "{{missing}}" },
		]));
		expect(rendered.errors[0]?.message).toBe("Unknown variable \"missing\"");
	});

	it("validates unknown variables without rendering", () => {
		expect(validateTemplateVariables("{{music}} {{missing|wikilink}}")).toEqual(["Unknown variable \"missing\""]);
	});

	it("hashes settings changes differently", () => {
		expect(journalTemplateSettingsHash(defaultMarkwaySettings())).not.toBe(journalTemplateSettingsHash(settingsWith([
			{ id: "title", key: "title", value: "{{title}}" },
		])));
	});

	it("hashes rendered property changes differently", () => {
		const first = renderJournalTemplateProperties(entry, defaultMarkwaySettings()).hash;
		const second = renderJournalTemplateProperties({ ...entry, musicAttachments: [] }, defaultMarkwaySettings()).hash;
		expect(first).not.toBe(second);
	});

	it("adds a title heading when enabled", () => {
		expect(renderJournalBody(entry, true)).toBe("# Flexoki\n\nBody");
	});

	it("leaves body alone when title heading is disabled", () => {
		expect(renderJournalBody(entry, false)).toBe("Body");
	});

	it("strips generated title heading before push", () => {
		expect(stripGeneratedTitleHeading("# Flexoki\n\nBody", "Flexoki")).toBe("Body");
	});

	it("does not strip unrelated headings", () => {
		expect(stripGeneratedTitleHeading("# Other\n\nBody", "Flexoki")).toBe("# Other\n\nBody");
	});
});
