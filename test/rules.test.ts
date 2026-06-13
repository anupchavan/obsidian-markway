import { describe, expect, it } from "vitest";
import {
	checkRules,
	cloneFilterGroup,
	defaultJournalRules,
	fieldNeedsValue,
	firstFolderFromRules,
	getOperatorsForField,
	getPropertyIcon,
	getPropertyLabel,
	inferPropertyType,
	normalizeFolderValue,
	normalizeFilterGroup,
	scanRuleProperties,
	type Filter,
	type FilterGroup,
	type FrontmatterRecord,
	type RuleApp,
	type RuleFile,
	type RuleFileCache,
} from "../src/rules";

function mockFile(overrides: Partial<RuleFile> = {}): RuleFile {
	const path = overrides.path ?? "Journal/Entry.md";
	const name = overrides.name ?? path.split("/").pop() ?? "Entry.md";
	const basename = overrides.basename ?? name.replace(/\.[^.]+$/, "");
	const parentPath = overrides.parent?.path ?? path.split("/").slice(0, -1).join("/");
	return {
		name,
		basename,
		path,
		extension: overrides.extension ?? name.split(".").pop() ?? "md",
		parent: overrides.parent ?? { path: parentPath },
		stat: overrides.stat ?? {
			size: 500,
			ctime: Date.UTC(2026, 5, 6),
			mtime: Date.UTC(2026, 5, 7),
		},
	};
}

function filter(field: string, operator: Filter["operator"], value = ""): Filter {
	return { type: "filter", field, operator, value };
}

function group(operator: FilterGroup["operator"], conditions: FilterGroup["conditions"]): FilterGroup {
	return { type: "group", operator, conditions };
}

function and(...conditions: FilterGroup["conditions"]): FilterGroup {
	return group("AND", conditions);
}

function appFor(options: {
	caches?: Record<string, RuleFileCache>;
	links?: Record<string, RuleFile>;
	files?: RuleFile[];
	types?: Record<string, string>;
} = {}): RuleApp {
	return {
		metadataCache: {
			getFileCache(file: RuleFile) {
				return options.caches?.[file.path] ?? {};
			},
			getFirstLinkpathDest(linkpath: string) {
				return options.links?.[linkpath] ?? null;
			},
		},
		vault: {
			getMarkdownFiles() {
				return options.files ?? [];
			},
		},
		metadataTypeManager: {
			getAssignedType(key: string) {
				return options.types?.[key];
			},
		},
	};
}

describe("journal rule defaults", () => {
	it("matches files in the default Journal folder", () => {
		expect(checkRules(appFor(), defaultJournalRules(), mockFile({ path: "Journal/Entry.md" }))).toBe(true);
	});

	it("does not match subfolders for the exact default folder rule", () => {
		expect(checkRules(appFor(), defaultJournalRules(), mockFile({ path: "Journal/Trips/Entry.md" }))).toBe(false);
	});

	it("does not match files outside the default Journal folder", () => {
		expect(checkRules(appFor(), defaultJournalRules(), mockFile({ path: "Notes/Entry.md" }))).toBe(false);
	});

	it("uses a custom folder when requested", () => {
		expect(checkRules(appFor(), defaultJournalRules("Diary"), mockFile({ path: "Diary/Entry.md" }))).toBe(true);
	});

	it("clones groups without sharing condition references", () => {
		const original = defaultJournalRules();
		const cloned = cloneFilterGroup(original);
		cloned.conditions.push(filter("file.name", "is", "Other.md"));
		expect(original.conditions).toHaveLength(1);
		expect(cloned.conditions).toHaveLength(2);
	});

	it("derives an import folder from a file folder rule", () => {
		expect(firstFolderFromRules(defaultJournalRules("Diary"))).toBe("Diary");
	});

	it("derives an import folder from a nested rule", () => {
		expect(firstFolderFromRules(group("OR", [group("AND", [filter("file", "in folder", "/Daily/")])]))).toBe("Daily");
	});

	it("removes unsafe segments when deriving import folders from rules", () => {
		expect(firstFolderFromRules(group("OR", [filter("file", "in folder", "../Daily/./Trips")]))).toBe("Daily/Trips");
	});

	it("derives an import folder from file.folder text rules", () => {
		expect(firstFolderFromRules(and(filter("file.folder", "starts with", "Writing/Journal")))).toBe("Writing/Journal");
	});

	it("returns null when rules do not imply a folder", () => {
		expect(firstFolderFromRules(and(filter("file.name", "contains", "Daily")))).toBeNull();
	});
});

describe("group logic", () => {
	it("allows empty rule groups", () => {
		expect(checkRules(appFor(), and(), mockFile())).toBe(true);
	});

	it("requires every condition in AND groups", () => {
		expect(checkRules(appFor(), and(filter("file.extension", "is", "md"), filter("file.basename", "contains", "Entry")), mockFile())).toBe(true);
	});

	it("rejects AND groups when one condition fails", () => {
		expect(checkRules(appFor(), and(filter("file.extension", "is", "md"), filter("file.basename", "contains", "Nope")), mockFile())).toBe(false);
	});

	it("accepts OR groups when any condition passes", () => {
		expect(checkRules(appFor(), group("OR", [filter("file.extension", "is", "pdf"), filter("file.extension", "is", "md")]), mockFile())).toBe(true);
	});

	it("rejects OR groups when every condition fails", () => {
		expect(checkRules(appFor(), group("OR", [filter("file.extension", "is", "pdf"), filter("file.basename", "is", "Other")]), mockFile())).toBe(false);
	});

	it("accepts NOR groups when no condition passes", () => {
		expect(checkRules(appFor(), group("NOR", [filter("file.extension", "is", "pdf"), filter("file.basename", "is", "Other")]), mockFile())).toBe(true);
	});

	it("rejects NOR groups when a condition passes", () => {
		expect(checkRules(appFor(), group("NOR", [filter("file.extension", "is", "md")]), mockFile())).toBe(false);
	});

	it("evaluates nested groups", () => {
		const rules = and(
			filter("file.extension", "is", "md"),
			group("OR", [filter("file.basename", "is", "Other"), filter("file.basename", "is", "Entry")])
		);
		expect(checkRules(appFor(), rules, mockFile())).toBe(true);
	});
});

describe("text operators", () => {
	it.each([
		["is", "Entry.md", true],
		["is", "Other.md", false],
		["is not", "Other.md", true],
		["contains", "try", true],
		["does not contain", "zzz", true],
		["starts with", "Ent", true],
		["does not start with", "No", true],
		["ends with", ".md", true],
		["does not end with", ".txt", true],
		["contains any of", "No,try", true],
		["contains any of", "No,Maybe", false],
		["does not contain any of", "No,Maybe", true],
		["contains all of", "Ent,.md", true],
		["contains all of", "Ent,No", false],
		["does not contain all of", "Ent,No", true],
		["is not empty", "", true],
	] as Array<[Filter["operator"], string, boolean]>)("file.name %s %s => %s", (operator, value, expected) => {
		expect(checkRules(appFor(), and(filter("file.name", operator, value)), mockFile())).toBe(expected);
	});

	it("detects empty scalar fields", () => {
		expect(checkRules(appFor(), and(filter("file.basename", "is empty")), mockFile({ basename: "" }))).toBe(true);
	});

	it("matches file paths", () => {
		expect(checkRules(appFor(), and(filter("file.path", "starts with", "Journal/")), mockFile())).toBe(true);
	});

	it("matches file folders", () => {
		expect(checkRules(appFor(), and(filter("file.folder", "contains", "Journal")), mockFile())).toBe(true);
	});

	it("matches file extensions", () => {
		expect(checkRules(appFor(), and(filter("file.extension", "is", "md")), mockFile())).toBe(true);
	});
});

describe("array and frontmatter operators", () => {
	const frontmatter: FrontmatterRecord = {
		aliases: ["Morning", "Reflection"],
		categories: ["personal", "journal"],
		status: "active",
		rating: 8,
		completed: true,
		tags: ["daily", "#writing"],
	};

	it.each([
		["categories", "is", "journal", true],
		["categories", "is", "missing", false],
		["categories", "is not", "missing", true],
		["categories", "contains", "person", true],
		["categories", "does not contain", "work", true],
		["categories", "contains any of", "work,journal", true],
		["categories", "contains any of", "work,ideas", false],
		["categories", "contains all of", "personal,journal", true],
		["categories", "contains all of", "personal,work", false],
		["categories", "does not contain any of", "work,ideas", true],
		["categories", "does not contain all of", "personal,work", true],
		["categories", "is exactly", "journal,personal", true],
		["categories", "is not exactly", "journal,work", true],
		["aliases", "contains", "Morning", true],
		["aliases", "is not empty", "", true],
		["missing", "is empty", "", true],
		["status", "is", "active", true],
		["status", "starts with", "act", true],
		["status", "ends with", "ive", true],
		["completed", "is", "true", true],
	] as Array<[string, Filter["operator"], string, boolean]>)("%s %s %s => %s", (field, operator, value, expected) => {
		expect(checkRules(appFor(), and(filter(field, operator, value)), mockFile(), frontmatter)).toBe(expected);
	});

	it("treats missing arrays as empty", () => {
		expect(checkRules(appFor(), and(filter("aliases", "is empty")), mockFile(), {})).toBe(true);
	});
});

describe("file operators", () => {
	it("matches direct folders", () => {
		expect(checkRules(appFor(), and(filter("file", "in folder", "Journal")), mockFile())).toBe(true);
	});

	it("matches nested folders", () => {
		expect(checkRules(appFor(), and(filter("file", "in folder", "Journal")), mockFile({ path: "Journal/Deep/Entry.md" }))).toBe(true);
	});

	it("rejects other folders", () => {
		expect(checkRules(appFor(), and(filter("file", "in folder", "Journal")), mockFile({ path: "Notes/Entry.md" }))).toBe(false);
	});

	it("supports inverse folder rules", () => {
		expect(checkRules(appFor(), and(filter("file", "is not in folder", "Notes")), mockFile())).toBe(true);
	});

	it("normalizes slashes in folder rules", () => {
		expect(checkRules(appFor(), and(filter("file", "in folder", "/Journal/")), mockFile())).toBe(true);
	});

	it("matches body tags", () => {
		const app = appFor({ caches: { "Journal/Entry.md": { tags: [{ tag: "#daily" }] } } });
		expect(checkRules(app, and(filter("file", "has tag", "daily")), mockFile())).toBe(true);
	});

	it("matches frontmatter tags", () => {
		expect(checkRules(appFor(), and(filter("file", "has tag", "writing")), mockFile(), { tags: ["#writing"] })).toBe(true);
	});

	it("matches parent tags", () => {
		const app = appFor({ caches: { "Journal/Entry.md": { tags: [{ tag: "#daily/morning" }] } } });
		expect(checkRules(app, and(filter("file", "has tag", "daily")), mockFile())).toBe(true);
	});

	it("supports inverse tag rules", () => {
		expect(checkRules(appFor(), and(filter("file", "does not have tag", "missing")), mockFile())).toBe(true);
	});

	it("matches existing frontmatter properties", () => {
		expect(checkRules(appFor(), and(filter("file", "has property", "status")), mockFile(), { status: "active" })).toBe(true);
	});

	it("supports inverse property rules", () => {
		expect(checkRules(appFor(), and(filter("file", "does not have property", "status")), mockFile(), {})).toBe(true);
	});

	it("matches outgoing links", () => {
		const target = mockFile({ path: "People/Ada.md" });
		const app = appFor({
			links: { Ada: target },
			caches: { "Journal/Entry.md": { links: [{ link: "Ada" }] } },
		});
		expect(checkRules(app, and(filter("file", "links to", "Ada")), mockFile())).toBe(true);
	});

	it("matches frontmatter wikilinks", () => {
		const target = mockFile({ path: "People/Ada.md" });
		const app = appFor({ links: { Ada: target } });
		expect(checkRules(app, and(filter("file", "links to", "Ada")), mockFile(), { person: "[[Ada|Ada Lovelace]]" })).toBe(true);
	});

	it("supports inverse link rules", () => {
		expect(checkRules(appFor(), and(filter("file", "does not link to", "Missing")), mockFile())).toBe(true);
	});

	it("exposes resolved links as file links", () => {
		const target = mockFile({ path: "People/Ada.md" });
		const app = appFor({
			links: { Ada: target },
			caches: { "Journal/Entry.md": { links: [{ link: "Ada" }] } },
		});
		expect(checkRules(app, and(filter("file links", "contains", "People/Ada")), mockFile())).toBe(true);
	});

	it("exposes body and frontmatter tags as file tags", () => {
		const app = appFor({ caches: { "Journal/Entry.md": { tags: [{ tag: "#daily" }] } } });
		expect(checkRules(app, and(filter("file tags", "contains all of", "daily,writing")), mockFile(), { tags: ["writing"] })).toBe(true);
	});
});

describe("number and date operators", () => {
	it.each([
		["=", "500", true],
		["!=", "300", true],
		["≠", "300", true],
		["<", "600", true],
		["<=", "500", true],
		["≤", "500", true],
		[">", "400", true],
		[">=", "500", true],
		["≥", "500", true],
		["=", "100", false],
	] as Array<[Filter["operator"], string, boolean]>)("file.size %s %s => %s", (operator, value, expected) => {
		expect(checkRules(appFor(), and(filter("file.size", operator, value)), mockFile())).toBe(expected);
	});

	it.each([
		["on", "2026-06-06", true],
		["not on", "2026-06-05", true],
		["before", "2026-06-07", true],
		["on or before", "2026-06-06", true],
		["after", "2026-06-05", true],
		["on or after", "2026-06-06", true],
		["on", "2026-06-05", false],
		["before", "2026-06-06", false],
	] as Array<[Filter["operator"], string, boolean]>)("file.ctime %s %s => %s", (operator, value, expected) => {
		expect(checkRules(appFor(), and(filter("file.ctime", operator, value)), mockFile())).toBe(expected);
	});

	it("compares frontmatter dates", () => {
		expect(checkRules(appFor(), and(filter("published", "on", "2026-06-06")), mockFile(), { published: "2026-06-06" })).toBe(true);
	});
});

describe("normalization and property discovery", () => {
	it("normalizes folder values without path traversal segments", () => {
		expect(normalizeFolderValue("\\Journal\\..\\Daily\\.\\Trips\\")).toBe("Journal/Daily/Trips");
	});

	it("normalizes invalid groups to the fallback", () => {
		expect(normalizeFilterGroup({ bad: true }, defaultJournalRules("Diary"))).toEqual(defaultJournalRules("Diary"));
	});

	it("normalizes bad conjunctions to AND", () => {
		const normalized = normalizeFilterGroup({ type: "group", operator: "BAD", conditions: [] });
		expect(normalized.operator).toBe("AND");
	});

	it("drops invalid child conditions", () => {
		const normalized = normalizeFilterGroup({ type: "group", operator: "AND", conditions: [null, { nope: true }] });
		expect(normalized.conditions).toHaveLength(0);
	});

	it("deduplicates repeated child conditions from persisted rules", () => {
		const folderRule = filter("file.folder", "is", "Journal");
		const nestedRule = group("AND", [filter("file.folder", "is", "Journal")]);
		const normalized = normalizeFilterGroup(group("AND", [
			folderRule,
			{ ...folderRule },
			nestedRule,
			group("AND", [filter("file.folder", "is", "Journal")]),
		]));
		expect(normalized.conditions).toEqual([folderRule, nestedRule]);
	});

	it("normalizes invalid filters to a file filter", () => {
		const normalized = normalizeFilterGroup({
			type: "group",
			operator: "AND",
			conditions: [{ type: "filter", field: "", operator: "bad", value: 123 }],
		});
		expect(normalized.conditions[0]).toEqual({ type: "filter", field: "file", operator: "links to", value: "123" });
	});

	it.each([
		["text", "hello"],
		["number", 1],
		["checkbox", true],
		["list", ["a"]],
		["date", "2026-06-06"],
		["datetime", "2026-06-06T10:00:00"],
		["unknown", null],
	] as const)("infers %s properties", (expected, value) => {
		expect(inferPropertyType(value)).toBe(expected);
	});

	it("discovers built-in and frontmatter properties", () => {
		const file = mockFile();
		const properties = scanRuleProperties(appFor({
			files: [file],
			caches: { [file.path]: { frontmatter: { status: "active", rating: 5 } } },
		}));
		expect(properties.map((property) => property.key)).toContain("file.path");
		expect(properties.map((property) => property.key)).toContain("status");
		expect(properties.find((property) => property.key === "rating")?.type).toBe("number");
	});

	it("uses Obsidian assigned property types when available", () => {
		const file = mockFile();
		const properties = scanRuleProperties(appFor({
			files: [file],
			types: { due: "date" },
			caches: { [file.path]: { frontmatter: { due: "someday" } } },
		}));
		expect(properties.find((property) => property.key === "due")?.type).toBe("date");
	});

	it("returns field-specific operators", () => {
		expect(getOperatorsForField("file", "file")).toContain("in folder");
	});

	it("returns type operators", () => {
		expect(getOperatorsForField("rating", "number")).toContain(">=");
	});

	it("knows which operators need values", () => {
		expect(fieldNeedsValue("contains")).toBe(true);
		expect(fieldNeedsValue("is empty")).toBe(false);
	});

	it("labels built-in properties", () => {
		expect(getPropertyLabel("file.basename")).toBe("file title");
	});

	it("assigns icons to built-in properties", () => {
		expect(getPropertyIcon("file tags", "list")).toBe("tags");
	});
});
