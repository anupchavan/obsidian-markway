import { describe, expect, it } from "vitest";
import { FILTERS } from "../src/journal-template/filters";
import type { FilterFunction } from "../src/journal-template/filters";

function applyFilter(name: string, value: string, param?: string): string | unknown[] {
	const filter: FilterFunction | undefined = FILTERS[name];
	if (!filter) {
		throw new Error(`Missing filter: ${name}`);
	}
	return filter(value, param);
}

describe("journal template filters", () => {
	it("keeps blockquote behavior for nested arrays", () => {
		expect(applyFilter("blockquote", JSON.stringify(["alpha", ["beta"]]))).toBe("> alpha\n> > beta");
	});

	it("capitalizes strings inside arrays and objects", () => {
		expect(applyFilter("capitalize", JSON.stringify({ greeting: "hello", tags: ["daily note"] }))).toBe(
			JSON.stringify({ Greeting: "Hello", Tags: ["Daily note"] })
		);
	});

	it("modifies dates with typed dayjs units", () => {
		expect(applyFilter("date_modify", "2026-03-12", "+1 day")).toBe("2026-03-13");
	});

	it("reads first, last, sliced, and nth array values", () => {
		const input = JSON.stringify(["zero", "one", "two", "three"]);
		expect(applyFilter("first", input)).toBe("zero");
		expect(applyFilter("last", input)).toBe("three");
		expect(applyFilter("slice", input, "1,3")).toBe(JSON.stringify(["one", "two"]));
		expect(applyFilter("nth", input, "2")).toBe(JSON.stringify(["one"]));
	});

	it("renders markdown helpers from JSON arrays and objects", () => {
		expect(applyFilter("footnote", JSON.stringify({ camelCase: "value" }))).toBe("[^camel-case]: value");
		expect(applyFilter("image", JSON.stringify({ "/tmp/photo.jpg": "Photo" }))).toEqual(["![Photo](/tmp/photo.jpg)"]);
		expect(applyFilter("link", JSON.stringify({ "https://example.com/a b": "Example" }))).toBe(
			"[Example](https://example.com/a%20b)"
		);
		expect(applyFilter("wikilink", JSON.stringify(["Page"]), "Alias")).toBe(JSON.stringify(["[[Page|Alias]]"]));
	});

	it("joins, lists, maps, and merges JSON arrays", () => {
		expect(applyFilter("join", JSON.stringify(["a", "b"]), '" | "')).toBe("a | b");
		expect(applyFilter("list", JSON.stringify([["child"], "root"]))).toBe("\t- child\n- root");
		expect(applyFilter("map", JSON.stringify([{ fileName: "One.md" }]), "item => item.fileName")).toBe(
			JSON.stringify(["One.md"])
		);
		expect(applyFilter("merge", JSON.stringify([1]), '"two","three"')).toBe(JSON.stringify([1, "two", "three"]));
	});

	it("formats object, number, round, reverse, and unique results", () => {
		expect(applyFilter("length", JSON.stringify({ a: 1, b: 2 }))).toBe("2");
		expect(applyFilter("object", JSON.stringify({ a: 1 }), "keys")).toBe(JSON.stringify(["a"]));
		expect(applyFilter("number_format", JSON.stringify({ n: 1234.5 }), '2,".","_"')).toBe(
			JSON.stringify({ n: "1_234.50" })
		);
		expect(applyFilter("round", JSON.stringify({ n: 1.235 }), "2")).toBe(JSON.stringify({ n: 1.24 }));
		expect(applyFilter("reverse", JSON.stringify({ a: 1, b: 2 }))).toBe(JSON.stringify({ b: 2, a: 1 }));
		expect(applyFilter("unique", JSON.stringify([1, 1, 2]))).toBe(JSON.stringify([1, 2]));
	});

	it("keeps string filters and markdown stripping behavior", () => {
		expect(applyFilter("pascal", "hello world")).toBe("HelloWorld");
		expect(applyFilter("replace", "a|b", '"|":"-"')).toBe("a-b");
		expect(applyFilter("safe_name", "CON?.md", "windows")).toBe("_CON.md");
		expect(applyFilter("safe_name", "a\u0001/b")).toBe("ab");
		expect(applyFilter("strip_md", "[title](url) **bold**")).toBe("title bold");
	});

	it("renders table, template, and title object output", () => {
		expect(applyFilter("table", JSON.stringify({ a: 1, b: 2 }))).toBe("| a | 1 |\n| - | - |\n| b | 2 |");
		expect(applyFilter("template", JSON.stringify([{ name: "A", value: 1 }]), '"${name}: ${value}"')).toBe("A: 1");
		expect(applyFilter("title", JSON.stringify({ "hello world": "a tale of two cities" }))).toBe(
			JSON.stringify({ "Hello World": "A Tale of Two Cities" })
		);
	});
});
