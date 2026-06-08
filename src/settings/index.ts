import { PluginSettingTab, requireApiVersion, Setting } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import type MarkwayPlugin from "../main";
import { renderJournalTemplatePropertyRow } from "../journal-template-ui";
import { renderJournalRules } from "../rules-ui";
import {
	DEFAULT_SETTINGS,
	normalizeDebounceMs,
	normalizeFolder,
	validateDebounceValue,
	type MarkwaySettings,
} from "../sync-utils";
import { renderLegacyGeneralSettings, renderLegacyJournalSettings } from "./legacy";

type MarkwaySettingKey = keyof MarkwaySettings;

export class MarkwaySettingTab extends PluginSettingTab {
	constructor(private plugin: MarkwayPlugin) {
		super(plugin.app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem<MarkwaySettingKey>[] {
		if (!requireApiVersion("1.13.0")) {
			return [];
		}

		return [
			{
				type: "page",
				name: "General",
				desc: "Sync behavior and vault connection.",
				items: this.generalItems(),
			},
			{
				type: "page",
				name: "Journal",
				desc: "Apple Journal sync options.",
				items: this.journalItems(),
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as MarkwaySettingKey];
	}

	async setControlValue(key: string, value: unknown) {
		switch (key as MarkwaySettingKey) {
			case "automaticSync":
				this.plugin.settings.automaticSync = value === true;
				break;
			case "debounceMs":
				this.plugin.settings.debounceMs = normalizeDebounceMs(value);
				break;
			case "vaultPathOverride":
				this.plugin.settings.vaultPathOverride = typeof value === "string" ? value.trim() : "";
				break;
			case "journalFolder":
				this.plugin.settings.journalFolder = typeof value === "string" ? normalizeFolder(value) : "";
				break;
			case "deleteJournalEntryWhenFileDeleted":
				this.plugin.settings.deleteJournalEntryWhenFileDeleted = value === true;
				break;
			case "deleteMarkdownFileWhenJournalDeleted":
				this.plugin.settings.deleteMarkdownFileWhenJournalDeleted = value === true;
				break;
			case "journalIncludeTitleHeading":
				this.plugin.settings.journalIncludeTitleHeading = value === true;
				this.plugin.queueTemplateRefresh();
				break;
		}
		await this.plugin.savePluginData();
	}

		display(): void {
			this.renderLegacySettings();
		}

		private renderLegacySettings(): void {
			const { containerEl } = this;
			containerEl.empty();
			renderLegacyGeneralSettings(containerEl, this.plugin);
			new Setting(containerEl).setName("Journal").setHeading();
			renderLegacyJournalSettings(containerEl, this.plugin, () => {
				this.renderLegacySettings();
			});
		}

	private generalItems(): SettingDefinitionItem<MarkwaySettingKey>[] {
		return [
			{
				name: "Automatic sync",
				desc: "Sync linked files after edits.",
				control: { type: "toggle", key: "automaticSync", defaultValue: true },
			},
			{
				name: "Debounce",
				desc: "Milliseconds to wait before an automatic push.",
				control: {
					type: "number",
					key: "debounceMs",
					defaultValue: DEFAULT_SETTINGS.debounceMs,
					min: 250,
					step: 50,
					validate: validateDebounceValue,
				},
			},
			{
				name: "Vault path override",
				desc: "Only needed if Obsidian cannot expose the local vault path.",
				control: {
					type: "text",
					key: "vaultPathOverride",
					placeholder: "/path/to/vault",
				},
			},
		];
	}

	private journalItems(): SettingDefinitionItem<MarkwaySettingKey>[] {
		return [
			{
				name: "Journal folder",
				desc: "Folder to use when importing Journal entries that are not already linked.",
				control: {
					type: "text",
					key: "journalFolder",
					placeholder: "Journal",
				},
			},
			this.rulesItem(),
			{
				name: "Sync Journal deletes",
				desc: "When a synced Markdown file is deleted, also delete its Apple Journal entry.",
				control: { type: "toggle", key: "deleteJournalEntryWhenFileDeleted", defaultValue: false },
			},
			{
				name: "Sync Obsidian deletes",
				desc: "When a synced Apple Journal entry is deleted, also delete its Markdown file.",
				control: { type: "toggle", key: "deleteMarkdownFileWhenJournalDeleted", defaultValue: false },
			},
			this.propertiesItem(),
			{
				name: "Add title as heading",
				desc: "Show the Journal title as the first Markdown heading when pulling entries.",
				control: { type: "toggle", key: "journalIncludeTitleHeading", defaultValue: false },
			},
		];
	}

	private rulesItem(): SettingDefinitionItem<MarkwaySettingKey> {
		return {
			name: "Rules",
			desc: "Choose which markdown files are automatically synced to journal",
			render: (setting) => {
				setting.settingEl.addClass("mw-rules-setting");
				setting.controlEl.empty();
				const rulesEl = setting.controlEl.createDiv({ cls: "mw-rules-settings-section" });
				renderJournalRules(
					rulesEl,
					this.plugin.app,
					this.plugin.settings.journalRules,
					async () => {
						await this.plugin.savePluginData();
					},
					() => {
							this.refreshDeclarativeSettings();
						},
						this.plugin.journalImportFolder()
					);
			},
		};
	}

	private propertiesItem(): SettingDefinitionItem<MarkwaySettingKey> {
		return {
			type: "list",
			heading: "Properties",
			emptyState: "No properties added yet.",
			addItem: {
				name: "Add property",
				action: () => {
					this.plugin.settings.journalProperties.push({
						id: `property-${Date.now().toString(36)}`,
						key: "",
						value: "{{title}}",
					});
						void this.plugin.savePluginData();
						this.plugin.queueTemplateRefresh();
						this.refreshDeclarativeSettings();
					},
				},
			onReorder: (oldIndex, newIndex) => {
				void this.reorderProperty(oldIndex, newIndex);
			},
			onDelete: (index) => {
				void this.deleteProperty(index);
			},
			items: this.plugin.settings.journalProperties.map((property) => ({
				name: property.key || "Property",
				searchable: false,
				render: (setting) => {
					renderJournalTemplatePropertyRow(
						setting,
						this.plugin,
							property,
							() => {
								this.refreshDeclarativeSettings();
							},
						() => {
							this.plugin.queueTemplateRefresh();
						}
					);
				},
			})),
		};
	}

	private async reorderProperty(oldIndex: number, newIndex: number): Promise<void> {
		const properties = this.plugin.settings.journalProperties;
		const [moved] = properties.splice(oldIndex, 1);
		if (!moved) {
			return;
		}
		properties.splice(newIndex, 0, moved);
			await this.plugin.savePluginData();
			this.plugin.queueTemplateRefresh();
			this.refreshDeclarativeSettings();
		}

		private async deleteProperty(index: number): Promise<void> {
			this.plugin.settings.journalProperties.splice(index, 1);
			await this.plugin.savePluginData();
			this.plugin.queueTemplateRefresh();
			this.refreshDeclarativeSettings();
		}

		private refreshDeclarativeSettings(): void {
			if (requireApiVersion("1.13.0")) {
				this.update();
			}
		}
	}
