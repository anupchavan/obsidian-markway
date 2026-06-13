import { describe, expect, it } from "vitest";
import { journalFolderSettingDefinition } from "../src/settings/definitions";

describe("declarative settings definitions", () => {
	it("uses Obsidian's official folder control for the journal folder", () => {
		const definition = journalFolderSettingDefinition();
		if (!("control" in definition)) {
			throw new Error("Journal folder setting must be a declarative control.");
		}

		expect(definition.control).toMatchObject({
			type: "folder",
			key: "journalFolder",
			placeholder: "Journal",
			includeRoot: true,
		});
	});
});
