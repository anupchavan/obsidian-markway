import { execFile } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
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
	autoScan: boolean;
	debounceMs: number;
	vaultPathOverride: string;
}

const DEFAULT_SETTINGS: MarkwaySettings = {
	markwayPath: defaultMarkwayPath(),
	autoScan: false,
	debounceMs: 1200,
	vaultPathOverride: "",
};

interface CommandResult {
	stdout: string;
	stderr: string;
}

interface BridgeRequest {
	id: string;
	kind: "doctor" | "journalPush";
	filePath?: string;
	title?: string;
	requestedAt: string;
}

interface BridgeResponse {
	id: string;
	ok: boolean;
	message: string;
	journalID?: string;
	completedAt: string;
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
			id: "diagnostics",
			name: "Show diagnostics",
			callback: () => {
				void this.showDiagnostics();
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
			const result = await this.sendBridgeRequest({ kind: "doctor" }, 15000);
			if (!result.ok) {
				throw new Error(result.message);
			}
			this.setStatus("Markway doctor passed");
			new Notice(result.message || "Markway doctor passed");
		} catch (error) {
			this.reportError("Markway doctor failed", error);
		}
	}

	private async showDiagnostics() {
		const lines = [
			`vault: ${this.safeValue(() => this.vaultPath())}`,
			`markway: ${this.settings.markwayPath}`,
			`markway exists: ${existsSync(this.settings.markwayPath)}`,
			`bridge: ${this.bridgeRoot()}`,
			`active file: ${this.app.workspace.getActiveFile()?.path ?? "(none)"}`,
		];
		const message = lines.join("\n");
		this.setStatus("Markway diagnostics ready");
		new Notice(message, 12000);
		console.debug(message);
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
			const result = await this.sendBridgeRequest({
				kind: "journalPush",
				filePath: absolutePath,
			});
			if (!result.ok || !result.journalID) {
				throw new Error(result.message || "Markway app did not return a Journal ID.");
			}
			const id = result.journalID;
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

	private async sendBridgeRequest(
		request: Omit<BridgeRequest, "id" | "requestedAt">,
		timeoutMs = 60000
	): Promise<BridgeResponse> {
		const id = randomUUID().toUpperCase();
		const fullRequest: BridgeRequest = {
			id,
			requestedAt: new Date().toISOString(),
			...request,
		};
		const requestsDir = this.requestsDir();
		const responsesDir = this.responsesDir();
		await mkdir(requestsDir, { recursive: true });
		await mkdir(responsesDir, { recursive: true });
		await writeFile(join(requestsDir, `${id}.json`), JSON.stringify(fullRequest, null, 2), "utf8");
		this.setStatus(`Markway request queued: ${request.kind}`);
		return await this.waitForBridgeResponse(id, timeoutMs);
	}

	private async waitForBridgeResponse(id: string, timeoutMs: number): Promise<BridgeResponse> {
		const responsePath = join(this.responsesDir(), `${id}.json`);
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			if (existsSync(responsePath)) {
				const text = await readFile(responsePath, "utf8");
				await rm(responsePath, { force: true });
				return JSON.parse(text) as BridgeResponse;
			}
			await sleep(350);
		}

		throw new Error(
			"Timed out waiting for Markway.app. Open Markway, set this vault path, and start the bridge."
		);
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

	private bridgeRoot(): string {
		return join(this.vaultPath(), ".markway");
	}

	private requestsDir(): string {
		return join(this.bridgeRoot(), "requests");
	}

	private responsesDir(): string {
		return join(this.bridgeRoot(), "responses");
	}

	private setStatus(text: string) {
		this.statusEl.setText(text);
	}

	private reportError(message: string, error: unknown) {
		const detail = explainMarkwayError(error);
		this.setStatus(message);
		new Notice(`${message}: ${detail}`);
		console.error(message, error);
	}

	private safeValue(read: () => string): string {
		try {
			return read();
		} catch (error) {
			return describeUnknown(error);
		}
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

function explainMarkwayError(value: unknown): string {
	const message = describeUnknown(value);
	if (
		message.includes("group.com.apple.moments")
		|| message.includes("Sandbox access to file-read-data denied")
		|| message.includes("Apple Journal access was denied")
		|| message.includes("moments.sqlite")
	) {
		return [
			"macOS denied Markway.app access to Apple Journal.",
			"Grant Full Disk Access to Markway.app, fully quit and reopen Markway.app, then start the bridge again.",
		].join(" ");
	}

	return message;
}

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function defaultMarkwayPath(): string {
	const installed = "/Users/anup/.local/bin/markway";
	if (existsSync(installed)) {
		return installed;
	}
	return "/Users/anup/projects/markway/.build/debug/markway";
}
