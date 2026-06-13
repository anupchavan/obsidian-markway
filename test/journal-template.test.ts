import { describe, expect, it } from "vitest";
import {
	journalTemplateNeedsAttachments,
	journalTemplateNeedsAttachmentMetadata,
	journalTemplateNeedsMusic,
	journalTemplateNeedsPhotos,
	journalTemplateSettingsHash,
	journalBodyContent,
	journalCreatedDateFromNoteName,
	journalTitleFromNoteName,
	parseJournalBodySections,
	renderJournalBodySections,
	renderJournalContent,
	renderJournalNoteName,
	renderJournalTemplateProperties,
	serializeJournalBody,
	splitContentTemplate,
	stripGeneratedContentChrome,
	stripGeneratedTitleHeading,
	validateContentTemplate,
	validateTemplateVariables,
} from "../src/journal-template";
import dayjs from "dayjs";
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
	photoAttachments: [
		{
			id: "C0CA3030-B29F-4CE2-AC30-EDB35E9E2BCB",
			source: "suggestionSheet",
			isHidden: false,
			isSlim: false,
			assetIdentifier: "8515CF3B-9AD0-430E-9CB5-83F010241A25:001:token:/var/mobile/Media",
			assetDate: 752084878.321,
			createdDate: "2026-06-04T18:09:27Z",
			suggestionDate: "2026-06-03T20:30:02Z",
			files: [
				{
					id: "BA8854C7-524C-4AA5-B7F7-7EDC52A822A9",
					name: "image",
					relativePath: "ENTRY-ID/C0CA3030/5D52141E_resized.heic",
					absolutePath: "/tmp/Attachments/ENTRY-ID/C0CA3030/5D52141E_resized.heic",
					exists: true,
					byteLength: 300229,
				},
			],
		},
		{
			id: "8D981B70-C82B-4D48-B6E9-B8686AA95CEE",
			source: "suggestionSheet",
			isHidden: true,
			isSlim: false,
			files: [
				{
					id: "FILE-VIDEO-ID",
					name: "video",
					relativePath: "ENTRY-ID/8D981B70/live.mov",
					absolutePath: "/tmp/Attachments/ENTRY-ID/8D981B70/live.mov",
				},
				{
					id: "FILE-IMAGE-ID",
					name: "image",
					relativePath: "ENTRY-ID/8D981B70/live.heic",
					absolutePath: "/tmp/Attachments/ENTRY-ID/8D981B70/live.heic",
				},
			],
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
		expect(rendered.attachmentPropertyItems.music).toEqual([
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
		// Web Clipper's replace filter requires the replacement to follow the
		// colon immediately: replace:"x":"y" (no space before the quote).
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{
				id: "music",
				key: "music",
				value: "{{music|map:item => item.title|replace:\"/ \\(Original Motion Picture Soundtrack\\)/g\":\"\"|wikilink}}",
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
		expect(renderJournalContent(entry, { ...defaultMarkwaySettings(), journalIncludeTitleHeading: true })).toBe("# Flexoki\n\nBody");
	});

	it("leaves body alone when title heading is disabled", () => {
		expect(renderJournalContent(entry, defaultMarkwaySettings())).toBe("Body");
	});

	it("strips generated title heading before push", () => {
		expect(stripGeneratedTitleHeading("# Flexoki\n\nBody", "Flexoki")).toBe("Body");
	});

	it("does not strip unrelated headings", () => {
		expect(stripGeneratedTitleHeading("# Other\n\nBody", "Flexoki")).toBe("# Other\n\nBody");
	});
});

describe("photo templates", () => {
	it("does not need photos with the default settings", () => {
		expect(journalTemplateNeedsPhotos(defaultMarkwaySettings())).toBe(false);
	});

	it("detects photo variables in configured properties", () => {
		expect(journalTemplateNeedsPhotos(settingsWith([
			{ id: "photos", key: "photos", value: "{{photos|map:item => item.fileName|wikilink}}" },
		]))).toBe(true);
	});

	it("detects photo variables in the content template", () => {
		expect(journalTemplateNeedsPhotos({
			...defaultMarkwaySettings(),
			journalContentTemplate: "{{content}}\n\nPhotos: {{photos|length}}",
		})).toBe(true);
	});

	it("detects attachments usage for music and photos", () => {
		const settings = settingsWith([
			{ id: "attachments", key: "attachments", value: "{{entry.attachments|map:item => item.title|wikilink}}" },
		]);
		expect(journalTemplateNeedsPhotos(settings)).toBe(true);
		expect(journalTemplateNeedsMusic(settings)).toBe(true);
	});

	it("renders photo file names as wikilinks", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "photos", key: "photos", value: "{{photos|map:item => item.fileName|wikilink}}" },
		]));
		expect(rendered.properties.photos).toEqual([
			"[[5D52141E_resized.heic]]",
			"[[live.heic]]",
		]);
	});

	it("renders photo paths", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "paths", key: "paths", value: "{{photos|map:item => item.path}}" },
		]));
		expect(rendered.properties.paths).toEqual([
			"/tmp/Attachments/ENTRY-ID/C0CA3030/5D52141E_resized.heic",
			"/tmp/Attachments/ENTRY-ID/8D981B70/live.heic",
		]);
	});

	it("renders photo counts", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "count", key: "photo_count", value: "{{photos|length}}" },
		]));
		expect(rendered.properties.photo_count).toBe(2);
	});

	it("converts photo capture dates from the Apple epoch", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "taken", key: "taken", value: "{{photos|map:item => item.takenAt}}" },
		]));
		expect(rendered.properties.taken).toEqual(["2024-10-31T16:27:58.321Z", ""]);
	});

	it("treats photos as photo, video, and live photo attachments", () => {
		const rendered = renderJournalTemplateProperties({
			...entry,
			photoAttachments: [
				...(entry.photoAttachments ?? []),
				{ id: "VIDEO-ID", assetType: "video", files: [{ id: "VIDEO-FILE", name: "video", relativePath: "ENTRY-ID/VIDEO-ID/clip.mov" }] },
				{ id: "LIVE-ID", assetType: "livePhoto", files: [{ id: "LIVE-FILE", name: "image", relativePath: "ENTRY-ID/LIVE-ID/live.heic" }] },
			],
		}, settingsWith([
			{ id: "types", key: "photo_types", value: "{{photos|map:item => item.type}}" },
		]));
		expect(rendered.properties.photo_types).toEqual(["photo", "photo", "video", "livePhoto"]);
	});

	it("tracks generated photo property items for removal sync", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "photos", key: "photos", value: "{{photos|map:item => item.fileName|wikilink}}" },
		]));
		expect(rendered.attachmentPropertyItems.photos).toEqual([
			{ id: "C0CA3030-B29F-4CE2-AC30-EDB35E9E2BCB", value: "[[5D52141E_resized.heic]]" },
			{ id: "8D981B70-C82B-4D48-B6E9-B8686AA95CEE", value: "[[live.heic]]" },
		]);
	});

	it("tracks generated music and photo items for attachments templates", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "attachments", key: "attachments", value: "{{entry.attachments|map:item => item.title|wikilink}}" },
		]));
		expect(rendered.attachmentPropertyItems.attachments).toEqual([
			{ id: "134D4F26-4E2C-414D-8F6F-C0D4274E7F66", value: "[[Sahiba / (Original Motion Picture Soundtrack)]]" },
			{ id: "3E161BEF-A5EF-4BFF-A229-0D7E2AF315E5", value: "[[How do you know]]" },
			{ id: "C0CA3030-B29F-4CE2-AC30-EDB35E9E2BCB", value: "[[5D52141E_resized.heic]]" },
			{ id: "8D981B70-C82B-4D48-B6E9-B8686AA95CEE", value: "[[live.heic]]" },
		]);
	});
});

describe("entry templates", () => {
	it("renders entry title and content", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "title", key: "entry_title", value: "{{entry.title}}" },
			{ id: "content", key: "entry_content", value: "{{entry.content}}" },
		]));
		expect(rendered.properties.entry_title).toBe("Flexoki");
		expect(rendered.properties.entry_content).toBe("Body");
	});

	it("renders combined attachments with types", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "types", key: "types", value: "{{entry.attachments|map:item => item.type}}" },
			{ id: "count", key: "count", value: "{{entry.attachments|length}}" },
		]));
		expect(rendered.properties.types).toEqual(["music", "music", "photo", "photo"]);
		expect(rendered.properties.count).toBe(4);
	});

	it("flags unknown entry keys during validation", () => {
		expect(validateTemplateVariables("{{entry.title}} {{entry.bogus}}")).toEqual([
			"Unknown variable \"entry.bogus\"",
		]);
	});

	it("accepts photos and entry variables during validation", () => {
		expect(validateTemplateVariables("{{photos|length}} {{entry.attachments|length}} {{entry.photos}}")).toEqual([]);
	});

	it("reports unknown entry keys when rendering", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "bad", key: "bad", value: "{{entry.bogus}}" },
		]));
		expect(rendered.errors[0]?.message).toBe("Unknown variable \"entry.bogus\"");
	});
});

describe("content templates", () => {
	it("renders a custom content template with section markers", () => {
		expect(renderJournalContent(entry, {
			...defaultMarkwaySettings(),
			journalContentTemplate: "{{entry.title}}\n\n{{entry.content}}",
		})).toBe("%% title %%\nFlexoki\n\n%% content %%\nBody");
	});

	it("treats a blank content template as the journal text", () => {
		expect(renderJournalContent(entry, {
			...defaultMarkwaySettings(),
			journalContentTemplate: "   ",
		})).toBe("Body");
	});

	it("falls back to the journal text when the content template has errors", () => {
		expect(renderJournalContent(entry, {
			...defaultMarkwaySettings(),
			journalContentTemplate: "{{contnet}}",
		})).toBe("Body");
	});

	it("adds the title heading above custom content templates", () => {
		expect(renderJournalContent(entry, {
			...defaultMarkwaySettings(),
			journalIncludeTitleHeading: true,
			journalContentTemplate: "{{content}}\n\nPhotos: {{photos|length}}",
		})).toBe("# Flexoki\n\nBody\n\n%% photos %%\nPhotos: 2");
	});

	it("hashes content template changes differently", () => {
		expect(journalTemplateSettingsHash(defaultMarkwaySettings())).not.toBe(journalTemplateSettingsHash({
			...defaultMarkwaySettings(),
			journalContentTemplate: "{{entry.content}}",
		}));
	});

	it("hashes photos property changes differently", () => {
		expect(journalTemplateSettingsHash(defaultMarkwaySettings())).not.toBe(journalTemplateSettingsHash({
			...defaultMarkwaySettings(),
			journalPhotosProperty: "photos",
		}));
	});

	it("keeps the created property setting push-only", () => {
		const settings = {
			...defaultMarkwaySettings(),
			journalCreatedProperty: "created_at",
		};
		expect(journalTemplateSettingsHash(defaultMarkwaySettings())).toBe(journalTemplateSettingsHash(settings));
		expect(renderJournalTemplateProperties(entry, settings).properties.created_at).toBeUndefined();
	});
});

describe("generic attachments variable", () => {
	const genericEntry: JournalEntryText = {
		...entry,
		attachments: [
			{
				id: "PHOTO-ID",
				assetType: "photo",
				source: "suggestionSheet",
				files: [
					{
						id: "FILE-ID",
						name: "image",
						relativePath: "ENTRY-ID/PHOTO-ID/photo.heic",
						absolutePath: "/tmp/Attachments/ENTRY-ID/PHOTO-ID/photo.heic",
					},
				],
				metadata: { date: 752084878.321, placeName: "Mamidipalle, Telangana" },
			},
			{
				id: "MUSIC-ID",
				assetType: "music",
				metadata: { song: "Sahiba", artistName: "Aditya Rikhari", mediaId: "1798404742" },
			},
			{
				id: "REFLECTION-ID",
				assetType: "reflection",
				metadata: {
					prompt: "Who is your wisest friend?",
					colorLight: "#212438",
					colorDark: "#3B3E52",
				},
			},
			{
				id: "MAP-ID",
				assetType: "multiPinMap",
				metadata: {
					visitsData: [
						{ city: "Mamidipalle", placeName: "Mumbai Highway", latitude: 17.59, longitude: 78.12, isWork: false, createdDate: 802197235.61 },
					],
				},
			},
			{
				id: "GENERIC-MAP-ID",
				assetType: "genericMap",
				metadata: {
					visitsData: {
						city: "",
						placeName: "IITH Main Road",
						latitude: 17.5806134,
						longitude: 78.1197393,
						visitStartTime: 802673883.39,
						visitEndTime: 802675091.06,
					},
				},
			},
			{
				id: "WALK-ID",
				assetType: "motionActivity",
				metadata: {
					activityType: "walk",
					localizedActivityName: "Walk",
					steps: "1019",
				},
			},
		],
	};

	it("keeps journal order and exposes attachment types", () => {
		const rendered = renderJournalTemplateProperties(genericEntry, settingsWith([
			{ id: "p", key: "kinds", value: "{{attachments|map:item => item.type}}" },
		]));
		expect(rendered.properties.kinds).toEqual(["photo", "music", "reflection", "multiPinMap", "genericMap", "motionActivity"]);
	});

	it("exposes type-specific titles", () => {
		const rendered = renderJournalTemplateProperties(genericEntry, settingsWith([
			{ id: "p", key: "titles", value: "{{attachments|map:item => item.title}}" },
		]));
		expect(rendered.properties.titles).toEqual([
			"photo.heic",
			"Sahiba",
			"Who is your wisest friend?",
			"Mumbai Highway",
			"IITH Main Road",
			"Walk",
		]);
	});

	it("exposes reflection colors and map visits", () => {
		// template renders one block per attachment; attachments without the
		// property render blank, so trim cleans up the joined output.
		const rendered = renderJournalTemplateProperties(genericEntry, settingsWith([
			{ id: "p1", key: "color", value: "{{attachments|template:\"${colorDark}\"|trim}}" },
			{ id: "p2", key: "city", value: "{{attachments|template:\"${visits.0.city}\"|trim}}" },
		]));
		expect(rendered.properties.color).toBe("#3B3E52");
		expect(rendered.properties.city).toBe("Mamidipalle");
	});

	it("exposes decoded reflections as their own variable", () => {
		const rendered = renderJournalTemplateProperties(genericEntry, settingsWith([
			{ id: "p1", key: "reflection_prompt", value: "{{reflection|template:\"${prompt}\"|trim}}" },
			{ id: "p2", key: "reflection_light", value: "{{entry.reflection|template:\"${colorLight}\"|trim}}" },
			{ id: "p3", key: "reflection_dark", value: "{{reflection|template:\"${colorDark}\"|trim}}" },
		]));
		expect(rendered.properties.reflection_prompt).toBe("Who is your wisest friend?");
		expect(rendered.properties.reflection_light).toBe("#212438");
		expect(rendered.properties.reflection_dark).toBe("#3B3E52");
	});

	it("skips empty generated frontmatter properties", () => {
		const rendered = renderJournalTemplateProperties({ ...entry, photoAttachments: [] }, settingsWith([
			{ id: "photos", key: "photos", value: "{{photos}}" },
			{ id: "blank", key: "blank", value: "   " },
			{ id: "count", key: "photo_count", value: "{{photos|length}}" },
		]));
		expect(rendered.properties).toEqual({ photo_count: 0 });
	});

	it("converts photo capture dates from the Apple epoch", () => {
		const rendered = renderJournalTemplateProperties(genericEntry, settingsWith([
			{ id: "p", key: "taken", value: "{{attachments|template:\"${takenAt}\"|trim}}" },
		]));
		expect(rendered.properties.taken).toBe("2024-10-31T16:27:58.321Z");
	});

	it("falls back to music and photos for older app builds", () => {
		const rendered = renderJournalTemplateProperties(entry, settingsWith([
			{ id: "p", key: "kinds", value: "{{attachments|map:item => item.type}}" },
		]));
		expect(rendered.properties.kinds).toEqual(["music", "music", "photo", "photo"]);
	});

	it("flattens map visits into the places variable", () => {
		const rendered = renderJournalTemplateProperties(genericEntry, settingsWith([
			{ id: "p1", key: "places", value: "{{places|map:item => item.title}}" },
			{ id: "p2", key: "starts", value: "{{places|map:item => item.date}}" },
		]));
		expect(rendered.properties.places).toEqual(["Mumbai Highway", "IITH Main Road"]);
		expect(rendered.properties.starts).toEqual([
			"2026-06-03T16:33:55.610Z",
			"2026-06-09T04:58:03.390Z",
		]);
	});

	it("exposes walk activity details", () => {
		const rendered = renderJournalTemplateProperties(genericEntry, settingsWith([
			{ id: "p", key: "steps", value: "{{attachments|template:\"${steps}\"|trim}}" },
		]));
		expect(rendered.properties.steps).toBe(1019);
	});

	it("requests generic attachments when places is used", () => {
		expect(journalTemplateNeedsAttachments(settingsWith([
			{ id: "p", key: "places", value: "{{places|length}}" },
		]))).toBe(true);
		expect(journalTemplateNeedsAttachments(settingsWith([
			{ id: "p", key: "reflection", value: "{{reflection|length}}" },
		]))).toBe(true);
	});

	it("requests generic attachments only when templates use them", () => {
		expect(journalTemplateNeedsAttachments(settingsWith([
			{ id: "p", key: "kinds", value: "{{attachments|length}}" },
		]))).toBe(true);
		expect(journalTemplateNeedsAttachments(settingsWith([
			{ id: "p", key: "music", value: "{{music}}" },
		]))).toBe(false);
		expect(journalTemplateNeedsAttachments({
			...defaultMarkwaySettings(),
			journalContentTemplate: "{{entry.attachments|length}}\n{{content}}",
		})).toBe(true);
	});

	it("treats attachment templates as metadata dependencies", () => {
		expect(journalTemplateNeedsAttachmentMetadata(settingsWith([
			{ id: "p", key: "title", value: "{{title}}" },
		]))).toBe(false);
		expect(journalTemplateNeedsAttachmentMetadata(settingsWith([
			{ id: "p", key: "photos", value: "{{photos|length}}" },
		]))).toBe(true);
		expect(journalTemplateNeedsAttachmentMetadata(settingsWith([
			{ id: "p", key: "places", value: "{{places|length}}" },
		]))).toBe(true);
		expect(journalTemplateNeedsAttachmentMetadata(settingsWith([
			{ id: "p", key: "reflection", value: "{{reflection|length}}" },
		]))).toBe(true);
		expect(journalTemplateNeedsAttachmentMetadata({
			...defaultMarkwaySettings(),
			journalPhotosProperty: "photos",
		})).toBe(true);
	});
});

describe("note names", () => {
	const NAME_TEMPLATE = "{{created|date:\"YYYY-MM-DD HHmm\"}} {{title}}";

	it("renders note names from the template", () => {
		expect(renderJournalNoteName(entry, {
			...defaultMarkwaySettings(),
			journalNoteNameTemplate: NAME_TEMPLATE,
		})).toBe(`${dayjs("2026-06-05T01:02:03Z").format("YYYY-MM-DD HHmm")} Flexoki`);
	});

	it("falls back to the title for blank or broken name templates", () => {
		expect(renderJournalNoteName(entry, {
			...defaultMarkwaySettings(),
			journalNoteNameTemplate: "  ",
		})).toBe("Flexoki");
		expect(renderJournalNoteName(entry, {
			...defaultMarkwaySettings(),
			journalNoteNameTemplate: "{{nope}}",
		})).toBe("Flexoki");
	});

	it("recovers the title from a templated note name", () => {
		expect(journalTitleFromNoteName("2026-06-11 1530 My Trip to Goa", NAME_TEMPLATE)).toBe("My Trip to Goa");
	});

	it("keeps titles containing date-like text", () => {
		expect(journalTitleFromNoteName("2026-06-11 1530 Planning 2027-01-01 party", NAME_TEMPLATE))
			.toBe("Planning 2027-01-01 party");
	});

	it("uses the whole name when the template does not match", () => {
		expect(journalTitleFromNoteName("Quick idea", NAME_TEMPLATE)).toBe("Quick idea");
		expect(journalTitleFromNoteName("Quick idea", "{{title}}")).toBe("Quick idea");
		expect(journalTitleFromNoteName("2026-06-11", "{{created|date:\"YYYY-MM-DD\"}}")).toBe("2026-06-11");
	});

	it("recovers titles when literal backslashes were sanitized in filenames", () => {
		expect(journalTitleFromNoteName(
			"2026-06-11 - My Trip",
			"{{created|date:\"YYYY-MM-DD\"}} \\ {{title}}"
		)).toBe("My Trip");
	});

	it("parses created times from the configured note name template", () => {
		const parsed = journalCreatedDateFromNoteName(
			"12 Mar 2026 4:49 PM - At it again",
			"{{created|date:\"DD MMM YYYY h:mm A\"}} - {{title}}"
		);
		expect(parsed).toMatchObject({
			raw: "12 Mar 2026 4:49 PM",
			format: "DD MMM YYYY h:mm A",
			hasDate: true,
			hasTime: true,
		});
		expect(parsed?.date.getFullYear()).toBe(2026);
		expect(parsed?.date.getMonth()).toBe(2);
		expect(parsed?.date.getDate()).toBe(12);
		expect(parsed?.date.getHours()).toBe(16);
		expect(parsed?.date.getMinutes()).toBe(49);
	});

	it("parses sanitized date separators and bracketed literals", () => {
		const parsed = journalCreatedDateFromNoteName(
			"2026.03.12 at 16-49 At it again",
			"{{created|date:\"YYYY.MM.DD [at] HH:mm\"}} {{title}}"
		);
		expect(parsed?.raw).toBe("2026.03.12 at 16-49");
		expect(parsed?.hasDate).toBe(true);
		expect(parsed?.hasTime).toBe(true);
		expect(parsed?.date.getHours()).toBe(16);
		expect(parsed?.date.getMinutes()).toBe(49);
	});

	it("parses created dates when backslash date separators were sanitized", () => {
		const parsed = journalCreatedDateFromNoteName(
			"2026-03-12 16-49 At it again",
			"{{created|date:\"YYYY\\MM\\DD HH:mm\"}} {{title}}"
		);
		expect(parsed?.raw).toBe("2026-03-12 16-49");
		expect(parsed?.hasDate).toBe(true);
		expect(parsed?.hasTime).toBe(true);
		expect(parsed?.date.getFullYear()).toBe(2026);
		expect(parsed?.date.getMonth()).toBe(2);
		expect(parsed?.date.getDate()).toBe(12);
		expect(parsed?.date.getHours()).toBe(16);
		expect(parsed?.date.getMinutes()).toBe(49);
	});

	it("detects date-only note name templates", () => {
		const parsed = journalCreatedDateFromNoteName(
			"2026-03-12 At it again",
			"{{created|date:\"YYYY-MM-DD\"}} {{title}}"
		);
		expect(parsed?.hasDate).toBe(true);
		expect(parsed?.hasTime).toBe(false);
	});
});

describe("content chrome separation", () => {
	it("splits templates at the content anchor", () => {
		expect(splitContentTemplate("{{photos}}\n{{content}}\n---")).toEqual({
			prefix: "{{photos}}\n",
			suffix: "\n---",
		});
	});

	it("splits entry.content anchors too", () => {
		expect(splitContentTemplate("intro\n{{ entry.content }}")).toEqual({
			prefix: "intro\n",
			suffix: "",
		});
	});

	it("does not treat filtered content as an anchor", () => {
		expect(splitContentTemplate("{{content|upper}}")).toBeNull();
	});

	it("returns null without a content anchor", () => {
		expect(splitContentTemplate("{{title}} only")).toBeNull();
	});

	it("renders marked sections around the journal text", () => {
		const sections = renderJournalBodySections(entry, {
			...defaultMarkwaySettings(),
			journalContentTemplate: "Photos: {{photos|length}}\n\n{{content}}\n\n---",
		});
		expect(sections).toEqual([
			{ kind: "generated", marker: "%% photos %%", text: "Photos: 2" },
			{ kind: "content", marker: "%% content %%", text: "Body" },
			{ kind: "generated", marker: "%% generated %%", text: "---" },
		]);
		expect(serializeJournalBody(sections)).toBe(
			"%% photos %%\nPhotos: 2\n\n%% content %%\nBody\n\n%% generated %%\n---"
		);
	});

	it("skips the content marker when content comes first", () => {
		const sections = renderJournalBodySections(entry, {
			...defaultMarkwaySettings(),
			journalContentTemplate: "{{content}}\n\nPhotos: {{photos|length}}",
		});
		expect(sections).toEqual([
			{ kind: "content", marker: "", text: "Body" },
			{ kind: "generated", marker: "%% photos %%", text: "Photos: 2" },
		]);
		expect(serializeJournalBody(sections)).toBe("Body\n\n%% photos %%\nPhotos: 2");
	});

	it("uses a single unmarked section for plain content templates", () => {
		expect(renderJournalBodySections(entry, defaultMarkwaySettings())).toEqual([
			{ kind: "content", marker: "", text: "Body" },
		]);
		expect(renderJournalBodySections(entry, {
			...defaultMarkwaySettings(),
			journalContentTemplate: "{{title}} only",
		})).toEqual([
			{ kind: "content", marker: "", text: "Body" },
		]);
	});

	it("round-trips the journal text through marker parsing", () => {
		const settings = {
			...defaultMarkwaySettings(),
			journalContentTemplate: "{{photos}}\n{{content}}",
		};
		const sections = renderJournalBodySections(entry, settings);
		const body = serializeJournalBody(sections);
		expect(journalBodyContent(body, sections)).toBe("Body");
	});

	it("recovers edited sections from the stored layout", () => {
		const layout = [
			{ kind: "generated" as const, marker: "%% photos %%" },
			{ kind: "content" as const, marker: "%% content %%" },
		];
		const body = "%% photos %%\n![[Testing - 1.jpg]]\nuser note under photos\n\n%% content %%\nedited body\nsecond line";
		expect(parseJournalBodySections(body, layout)).toEqual([
			{ kind: "generated", marker: "%% photos %%", text: "![[Testing - 1.jpg]]\nuser note under photos" },
			{ kind: "content", marker: "%% content %%", text: "edited body\nsecond line" },
		]);
	});

	it("returns null when the markers were removed", () => {
		const layout = [
			{ kind: "generated" as const, marker: "%% photos %%" },
			{ kind: "content" as const, marker: "%% content %%" },
		];
		expect(parseJournalBodySections("no markers here", layout)).toBeNull();
		expect(journalBodyContent("no markers here", layout)).toBeNull();
	});

	it("labels generated sections with vault photo file names", () => {
		const sections = renderJournalBodySections(
			entry,
			{
				...defaultMarkwaySettings(),
				journalContentTemplate: "{{photos|template:\"![[${fileName}]]\"|trim}}\n{{content}}",
			},
			{
				"C0CA3030-B29F-4CE2-AC30-EDB35E9E2BCB": "Attachments/Testing - 1.jpg",
				"8D981B70-C82B-4D48-B6E9-B8686AA95CEE": "Attachments/Testing - 2.jpg",
			}
		);
		expect(sections[0]?.text).toBe("![[Testing - 1.jpg]]\n\n![[Testing - 2.jpg]]");
	});

	it("strips suffix chrome for trailing template text", () => {
		const stripped = stripGeneratedContentChrome("Boka laal uimaas", "", "s");
		expect(stripped).toBe("Boka laal uimaa");
	});

	it("leaves edited chrome alone instead of guessing", () => {
		expect(stripGeneratedContentChrome("Photos: 1\n\nBody", "Photos: 2\n\n", "")).toBe("Photos: 1\n\nBody");
		expect(stripGeneratedContentChrome("Body", "", "\n\n---")).toBe("Body");
	});

	it("strips prefix and suffix independently", () => {
		expect(stripGeneratedContentChrome("edited prefix\nBody\n\n---", "Photos: 2\n", "\n\n---")).toBe("edited prefix\nBody");
	});

	it("renders photo embeds through the template filter", () => {
		const settings = {
			...defaultMarkwaySettings(),
			journalContentTemplate: "{{photos|map:item => item.fileName|template:\"![[${str}]]\"}}\n\n{{content}}",
		};
		const sections = renderJournalBodySections(entry, settings);
		expect(sections[0]?.text).toBe("![[5D52141E_resized.heic]]\n\n![[live.heic]]");
	});

	it("renders object properties through the template filter", () => {
		const settings = {
			...defaultMarkwaySettings(),
			journalContentTemplate: "{{photos|template:\"![[${fileName}]]\"}}\n\n{{content}}",
		};
		const sections = renderJournalBodySections(entry, settings);
		expect(sections[0]?.text).toBe("![[5D52141E_resized.heic]]\n\n![[live.heic]]");
	});

	it("warns when the content template has no anchor", () => {
		expect(validateContentTemplate("{{title}} only")).toEqual([
			"Include {{content}} on its own so the journal text stays separate from generated content. Without it, Markway syncs the journal text alone.",
		]);
	});

	it("accepts the default content template", () => {
		expect(validateContentTemplate("")).toEqual([]);
		expect(validateContentTemplate("{{photos}}\n{{content}}")).toEqual([]);
	});
});
