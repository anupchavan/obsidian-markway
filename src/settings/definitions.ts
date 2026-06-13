import type { SettingDefinitionItem } from "obsidian";
import type { MarkwaySettings } from "../sync-utils";

export type MarkwaySettingKey = keyof MarkwaySettings;

export function journalFolderSettingDefinition(): SettingDefinitionItem<MarkwaySettingKey> {
	return {
		name: "Journal folder",
		desc: "Folder to use when importing Journal entries that are not already linked.",
		control: {
			type: "folder",
			key: "journalFolder",
			placeholder: "Journal",
			includeRoot: true,
		},
	};
}
