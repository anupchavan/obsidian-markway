import { execFile } from "child_process";
import {
	FileSystemAdapter,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
} from "obsidian";

interface MarkwaySettings {
	markwayPath: string;
	journalToolPath: string;
	autoScan: boolean;
	debounceMs: number;
	vaultPathOverride: string;
}

const DEFAULT_SETTINGS: MarkwaySettings = {
	markwayPath: "/Users/anup/projects/markway/.build/debug/markway",
	journalToolPath: "/Users/anup/projects/markway/Vendor/AppleJournalCRDT/tools/journal_text.zsh",
	autoScan: false,
	debounceMs: 1200,
	vaultPathOverride: "",
};

interface CommandResult {
	stdout: string;
	stderr: string;
}

export default class MarkwayPlugin extends Plugin {
	settings: MarkwaySettings;
	private statusEl!: HTMLElement;
	private scanTimer: ReturnType<typeof setTimeout> | null = null;

	async onload() {
		await this.loadSettings();

		this.statusEl = this.addStatusBarItem();
		this.setStatus("Markway idle");

		this.addSettingTab(new MarkwaySettingTab(this));
		this.registerVaultEvents();
		this.registerCommands();
	}

	onunload() {
		if (this.scanTimer) {
			clearTimeout(this.scanTimer);
		}
	}

	async loadSettings() {
		const loaded: unknown = await this.loadData();
		this.settings = { ...DEFAULT_SETTINGS, ...readSettings(loaded) };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private registerCommands() {
		this.addCommand({
			id: "doctor",
			name: "Run doctor",
			callback: () => {
				void this.runDoctor();
			},
		});

		this.addCommand({
			id: "scan-vault",
			name: "Scan vault",
			callback: () => {
				void this.scanVault("manual");
			},
		});

		this.addCommand({
			id: "push-current-file",
			name: "Push current file to journal",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const canRun = file instanceof TFile && file.extension === "md";
				if (checking) {
					return canRun;
				}
				if (canRun && file) {
					void this.pushFile(file);
				}
				return true;
			},
		});
	}

	private registerVaultEvents() {
		this.registerEvent(this.app.vault.on("create", (file) => this.queueScanForFile(file, "create")));
		this.registerEvent(this.app.vault.on("modify", (file) => this.queueScanForFile(file, "modify")));
		this.registerEvent(this.app.vault.on("delete", (file) => this.queueScanForFile(file, "delete")));
		this.registerEvent(this.app.vault.on("rename", (file) => this.queueScanForFile(file, "rename")));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.queueScanForFile(file, "metadata")));
	}

	private queueScanForFile(file: TAbstractFile, reason: string) {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}

		this.setStatus(`Markway saw ${reason}: ${file.path}`);

		if (!this.settings.autoScan) {
			return;
		}

		if (this.scanTimer) {
			clearTimeout(this.scanTimer);
		}

		this.scanTimer = setTimeout(() => {
			this.scanTimer = null;
			void this.scanVault(reason);
		}, Math.max(250, this.settings.debounceMs));
	}

	private async runDoctor() {
		try {
			const result = await this.runMarkway([
				"doctor",
				...this.journalToolOption(),
			]);
			this.setStatus("Markway doctor passed");
			new Notice(result.stdout.trim() || "Markway doctor passed");
		} catch (error) {
			this.reportError("Markway doctor failed", error);
		}
	}

	private async scanVault(reason: string) {
		try {
			const vaultPath = this.vaultPath();
			const result = await this.runMarkway(["sync", "once", "--vault", vaultPath]);
			this.setStatus(`Markway scanned vault (${reason})`);
			new Notice(result.stdout.trim() || "Markway scan complete");
		} catch (error) {
			this.reportError("Markway scan failed", error);
		}
	}

	private async pushFile(file: TFile) {
		try {
			const absolutePath = `${this.vaultPath()}/${file.path}`;
			const result = await this.runMarkway([
				"journal",
				"push",
				absolutePath,
				"--no-write-frontmatter",
				...this.journalToolOption(),
			]);
			const id = result.stdout.trim();
			await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
				const metadata = frontmatter as Record<string, string>;
				metadata["markway.appleJournalID"] = id;
				metadata["markway.lastSyncedAt"] = new Date().toISOString();
			});
			this.setStatus(`Markway pushed ${file.path}`);
			new Notice(id || `Pushed ${file.path}`);
		} catch (error) {
			this.reportError(`Markway push failed for ${file.path}`, error);
		}
	}

	private runMarkway(args: string[]): Promise<CommandResult> {
		const command = this.settings.markwayPath.trim() || "markway";
		return new Promise((resolve, reject) => {
				execFile(command, args, { cwd: this.vaultPath() }, (error, stdout, stderr) => {
					if (error) {
						reject(new Error([describeUnknown(error), stderr, stdout].filter(Boolean).join("\n")));
						return;
					}
				resolve({ stdout, stderr });
			});
		});
	}

	private vaultPath(): string {
		const override = this.settings.vaultPathOverride.trim();
		if (override) {
			return override;
		}

		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return adapter.getBasePath();
		}

		throw new Error("Markway needs a local desktop vault path.");
	}

	private journalToolOption(): string[] {
		const path = this.settings.journalToolPath.trim();
		return path ? ["--journal-tool", path] : [];
	}

	private setStatus(text: string) {
		this.statusEl.setText(text);
	}

	private reportError(message: string, error: unknown) {
		const detail = error instanceof Error ? error.message : String(error);
		this.setStatus(message);
		new Notice(`${message}: ${detail}`);
		console.error(message, error);
	}
}

class MarkwaySettingTab extends PluginSettingTab {
	constructor(private plugin: MarkwayPlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

			new Setting(containerEl)
				.setName("Markway executable")
				.setDesc("Path to the native markway command.")
			.addText((text) =>
				text
					.setPlaceholder("Markway")
					.setValue(this.plugin.settings.markwayPath)
					.onChange(async (value) => {
						this.plugin.settings.markwayPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

			new Setting(containerEl)
				.setName("Journal helper")
				.setDesc("Path to journal_text.zsh while the journal backend is still vendored.")
			.addText((text) =>
				text
					.setPlaceholder("Journal helper path")
					.setValue(this.plugin.settings.journalToolPath)
					.onChange(async (value) => {
						this.plugin.settings.journalToolPath = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Vault path override")
			.setDesc("Only needed if Obsidian cannot expose the local vault path.")
			.addText((text) =>
				text
					.setPlaceholder("/path/to/vault")
					.setValue(this.plugin.settings.vaultPathOverride)
					.onChange(async (value) => {
						this.plugin.settings.vaultPathOverride = value.trim();
						await this.plugin.saveSettings();
					})
			);

			new Setting(containerEl)
				.setName("Auto scan")
				.setDesc("Run a scan after changes.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoScan)
					.onChange(async (value) => {
						this.plugin.settings.autoScan = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Debounce")
			.setDesc("Milliseconds to wait before an automatic scan.")
			.addText((text) =>
				text
					.setPlaceholder("1200")
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						const parsed = Number.parseInt(value, 10);
						if (Number.isFinite(parsed)) {
							this.plugin.settings.debounceMs = parsed;
							await this.plugin.saveSettings();
						}
					})
			);
	}
}

function readSettings(value: unknown): Partial<MarkwaySettings> {
	if (!isRecord(value)) {
		return {};
	}

	const settings: Partial<MarkwaySettings> = {};
	if (typeof value.markwayPath === "string") {
		settings.markwayPath = value.markwayPath;
	}
	if (typeof value.journalToolPath === "string") {
		settings.journalToolPath = value.journalToolPath;
	}
	if (typeof value.autoScan === "boolean") {
		settings.autoScan = value.autoScan;
	}
	if (typeof value.debounceMs === "number") {
		settings.debounceMs = value.debounceMs;
	}
	if (typeof value.vaultPathOverride === "string") {
		settings.vaultPathOverride = value.vaultPathOverride;
	}
	return settings;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function describeUnknown(value: unknown): string {
	if (value instanceof Error) {
		return value.message;
	}

	if (typeof value === "string") {
		return value;
	}

	return JSON.stringify(value) ?? "Unknown error";
}
