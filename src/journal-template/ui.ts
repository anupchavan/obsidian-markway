import { Setting, setIcon } from "obsidian";
import type MarkwayPlugin from "../main";
import { validateContentTemplate, validateTemplateVariables } from ".";
import { PropertySuggest } from "../rule-suggests";
import { normalizeTemplatePropertyKey, type JournalTemplateProperty } from "../sync-utils";

export function renderJournalTemplateSettings(
	container: HTMLElement,
	plugin: MarkwayPlugin,
	onRefresh: () => void,
	onTemplateChanged: () => void = () => { }
): void {
	new Setting(container)
		.setName("Properties")
		.setDesc("Properties to add to the top of synced journal notes. Use variables to pre-populate data from journal.")
		.setHeading();

	const list = container.createDiv({ cls: "mw-template-properties" });
	for (const property of plugin.settings.journalProperties) {
		renderPropertyRow(list, plugin, property, onRefresh, onTemplateChanged);
	}

	const actions = container.createDiv({ cls: "mw-template-actions" });
	const addButton = actions.createDiv({ cls: "mw-text-icon-button mw-template-add-button" });
	const addIcon = addButton.createSpan({ cls: "mw-text-button-icon" });
	setIcon(addIcon, "plus");
	addButton.createSpan({ text: "Add property" });
	addButton.addEventListener("click", () => {
		void (async () => {
			plugin.settings.journalProperties.push({
				id: `property-${Date.now().toString(36)}`,
				key: "",
				value: "{{title}}",
			});
			await plugin.savePluginData();
			onTemplateChanged();
			onRefresh();
		})();
	});

	new Setting(container)
		.setName("Note content")
		.setDesc("Controls the note body when pulling journal entries.")
		.setHeading();

	const noteNameSetting = new Setting(container)
		.setName("Note name")
		.setDesc("Format for the file name of the entry. You can use variables like {{title}} and {{created}} to pre-populate data from the entry.");
	renderJournalNoteNameControl(noteNameSetting, plugin, onTemplateChanged);

	const contentSetting = new Setting(container)
		.setName("Content template")
		.setDesc("Template for the note body. {{content}} is the journal entry text.");
	renderJournalContentTemplateControl(contentSetting, plugin, onTemplateChanged);

	const photosSetting = new Setting(container)
		.setName("Photos property")
		.setDesc("Markway downloads journal photos and videos into your attachment folder and lists them in this property. Remove a value to delete that journal attachment, or add an image or video from your vault to attach it. Leave empty to disable.");
	renderJournalPhotosPropertyControl(photosSetting, plugin, onTemplateChanged);

	const createdSetting = new Setting(container)
		.setName("Created property")
		.setDesc("Frontmatter property to read when pushing the journal created date. Edit it in Obsidian to update the journal entry date. Leave empty to disable.");
	renderJournalCreatedPropertyControl(createdSetting, plugin, onTemplateChanged);
}

export function renderJournalNoteNameControl(
	setting: Setting,
	plugin: MarkwayPlugin,
	onTemplateChanged: () => void = () => { }
): void {
	let warningsEl: HTMLElement | null = null;

	const renderWarnings = () => {
		warningsEl?.remove();
		warningsEl = renderSettingWarnings(setting, validateTemplateVariables(plugin.settings.journalNoteNameTemplate));
	};

	setting.addText((text) => {
		text.setPlaceholder("{{title}}");
		text.setValue(plugin.settings.journalNoteNameTemplate);
		text.inputEl.addEventListener("change", () => {
			void (async () => {
				plugin.settings.journalNoteNameTemplate = text.inputEl.value;
				await plugin.savePluginData();
				renderWarnings();
				onTemplateChanged();
			})();
		});
	});

	renderWarnings();
}

export function renderJournalContentTemplateControl(
	setting: Setting,
	plugin: MarkwayPlugin,
	onTemplateChanged: () => void = () => { }
): void {
	setting.settingEl.addClass("mw-template-setting");
	let warningsEl: HTMLElement | null = null;

	const renderWarnings = () => {
		warningsEl?.remove();
		warningsEl = renderSettingWarnings(setting, validateContentTemplate(plugin.settings.journalContentTemplate));
	};

	setting.addTextArea((textArea) => {
		textArea.setPlaceholder("{{content}}");
		textArea.setValue(plugin.settings.journalContentTemplate);
		textArea.inputEl.addClass("mw-template-content-textarea");
		textArea.inputEl.rows = 4;
		textArea.inputEl.addEventListener("change", () => {
			void (async () => {
				plugin.settings.journalContentTemplate = textArea.inputEl.value;
				await plugin.savePluginData();
				renderWarnings();
				onTemplateChanged();
			})();
		});
	});

	renderWarnings();
}

export function renderJournalPhotosPropertyControl(
	setting: Setting,
	plugin: MarkwayPlugin,
	onTemplateChanged: () => void = () => { }
): void {
	renderJournalPropertyKeyControl(
		setting,
		plugin,
		"Photos",
		() => plugin.settings.journalPhotosProperty,
		(value) => {
			plugin.settings.journalPhotosProperty = value;
		},
		onTemplateChanged
	);
}

export function renderJournalCreatedPropertyControl(
	setting: Setting,
	plugin: MarkwayPlugin,
	onTemplateChanged: () => void = () => { }
): void {
	renderJournalPropertyKeyControl(
		setting,
		plugin,
		"created",
		() => plugin.settings.journalCreatedProperty,
		(value) => {
			plugin.settings.journalCreatedProperty = value;
		},
		onTemplateChanged
	);
}

function renderJournalPropertyKeyControl(
	setting: Setting,
	plugin: MarkwayPlugin,
	placeholder: string,
	getValue: () => string,
	setValue: (value: string) => void,
	onTemplateChanged: () => void
): void {
	setting.addText((text) => {
		text.setPlaceholder(placeholder);
		text.setValue(getValue());

		const save = (raw: string) => {
			void (async () => {
				const value = normalizeTemplatePropertyKey(raw);
				setValue(value);
				text.inputEl.value = value;
				await plugin.savePluginData();
				onTemplateChanged();
			})();
		};
		text.inputEl.addEventListener("change", () => {
			save(text.inputEl.value);
		});
		new PropertySuggest(plugin.app, text.inputEl).onSelectCb((value) => {
			text.inputEl.value = value;
			save(value);
		});
	});
}

function renderSettingWarnings(setting: Setting, messages: string[]): HTMLElement | null {
	if (messages.length === 0) {
		return null;
	}
	const warningsEl = setting.settingEl.createDiv({ cls: "mw-template-content-warnings" });
	for (const message of messages) {
		const warning = warningsEl.createDiv({ cls: "mw-template-warning mw-template-content-warning" });
		const warningIcon = warning.createSpan({ cls: "mw-template-warning-icon" });
		setIcon(warningIcon, "triangle-alert");
		warning.createSpan({ text: message });
	}
	return warningsEl;
}

export function renderJournalTemplatePropertyRow(
	setting: Setting,
	plugin: MarkwayPlugin,
	property: JournalTemplateProperty,
	onRefresh: () => void,
	onTemplateChanged: () => void = () => { }
): void {
	setting.settingEl.addClass("mw-template-property-list-item");
	setting.infoEl.empty();
	setting.controlEl.empty();
	renderPropertyRow(setting.controlEl, plugin, property, onRefresh, onTemplateChanged);
}

function renderPropertyRow(
	container: HTMLElement,
	plugin: MarkwayPlugin,
	property: JournalTemplateProperty,
	onRefresh: () => void,
	onTemplateChanged: () => void
): void {
	const rowWrap = container.createDiv({ cls: "mw-template-property-wrap" });
	const row = rowWrap.createDiv({ cls: "mw-template-property-row" });

	const typeIcon = row.createDiv({ cls: "mw-template-property-icon" });
	setIcon(typeIcon, "list");

	const keyInput = row.createEl("input", {
		cls: "mw-template-property-key",
		type: "text",
		placeholder: "property",
		value: property.key,
	});
	const savePropertyKey = () => {
		void (async () => {
			property.key = normalizeTemplatePropertyKey(keyInput.value);
			keyInput.value = property.key;
			await plugin.savePluginData();
			onTemplateChanged();
			onRefresh();
		})();
	};
	keyInput.addEventListener("change", savePropertyKey);
	new PropertySuggest(plugin.app, keyInput).onSelectCb((value) => {
		keyInput.value = value;
		savePropertyKey();
	});

	const valueInput = row.createEl("input", {
		cls: "mw-template-property-value",
		type: "text",
		placeholder: "{{title}}",
		value: property.value,
	});
	valueInput.addEventListener("change", () => {
		void (async () => {
			property.value = valueInput.value;
			await plugin.savePluginData();
			onTemplateChanged();
			onRefresh();
		})();
	});

	for (const message of validateTemplateVariables(property.value)) {
		const warning = rowWrap.createDiv({ cls: "mw-template-warning" });
		const warningIcon = warning.createSpan({ cls: "mw-template-warning-icon" });
		setIcon(warningIcon, "triangle-alert");
		warning.createSpan({ text: message });
	}
}
