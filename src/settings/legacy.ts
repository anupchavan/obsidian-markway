import { Setting } from "obsidian";
import type MarkwayPlugin from "../main";
import { renderJournalTemplateSettings } from "../journal-template-ui";
import { renderJournalRules } from "../rules-ui";
import { DEFAULT_SETTINGS, normalizeDebounceMs, normalizeFolder } from "../sync-utils";

export function renderLegacyJournalSettings(
	containerEl: HTMLElement,
	plugin: MarkwayPlugin,
	onRefresh: () => void
): void {
	new Setting(containerEl)
		.setName("Journal folder")
		.setDesc("Folder to use when importing journal entries that are not already linked.")
		.addText((text) =>
			text
				.setPlaceholder("Journal")
				.setValue(plugin.settings.journalFolder)
				.onChange(async (value) => {
					plugin.settings.journalFolder = normalizeFolder(value);
					await plugin.savePluginData();
				})
		);

	new Setting(containerEl)
		.setName("Rules")
		.setDesc("Choose which Markdown files are automatically synced to journal.")
		.setHeading();

	const rulesEl = containerEl.createDiv({ cls: "mw-rules-settings-section" });
	renderJournalRules(
		rulesEl,
		plugin.app,
		plugin.settings.journalRules,
		async () => {
			await plugin.savePluginData();
		},
		plugin.journalImportFolder()
	);

	new Setting(containerEl)
		.setName("Delete journal entries")
		.setDesc("When a synced vault file is deleted, also delete its journal entry.")
		.addToggle((toggle) =>
			toggle
				.setValue(plugin.settings.deleteJournalEntryWhenFileDeleted)
				.onChange(async (value) => {
					plugin.settings.deleteJournalEntryWhenFileDeleted = value;
					await plugin.savePluginData();
				})
		);

	new Setting(containerEl)
		.setName("Delete vault files")
		.setDesc("When a synced journal entry is deleted, also move its vault file to trash.")
		.addToggle((toggle) =>
			toggle
				.setValue(plugin.settings.deleteMarkdownFileWhenJournalDeleted)
				.onChange(async (value) => {
					plugin.settings.deleteMarkdownFileWhenJournalDeleted = value;
					await plugin.savePluginData();
				})
		);

	new Setting(containerEl).setName("Content").setHeading();
	renderJournalTemplateSettings(containerEl, plugin, onRefresh, () => {
		plugin.queueTemplateRefresh();
	});
}

export function renderLegacyGeneralSettings(containerEl: HTMLElement, plugin: MarkwayPlugin): void {
	new Setting(containerEl).setName("Sync behavior").setHeading();
	new Setting(containerEl)
		.setName("Automatic sync")
		.setDesc("Sync linked files after edits.")
		.addToggle((toggle) =>
			toggle
				.setValue(plugin.settings.automaticSync)
				.onChange(async (value) => {
					plugin.settings.automaticSync = value;
					await plugin.savePluginData();
				})
		);

	new Setting(containerEl)
		.setName("Debounce")
		.setDesc("Milliseconds to wait before an automatic push.")
		.addText((text) =>
			text
				.setPlaceholder(String(DEFAULT_SETTINGS.debounceMs))
				.setValue(String(plugin.settings.debounceMs))
				.onChange(async (value) => {
					plugin.settings.debounceMs = normalizeDebounceMs(value);
					await plugin.savePluginData();
				})
		);

	new Setting(containerEl)
		.setName("Vault path override")
		.setDesc("Only needed if Obsidian cannot expose the local vault path.")
		.addText((text) =>
			text
				.setPlaceholder("/path/to/vault")
				.setValue(plugin.settings.vaultPathOverride)
				.onChange(async (value) => {
					plugin.settings.vaultPathOverride = value.trim();
					await plugin.savePluginData();
				})
		);
}
