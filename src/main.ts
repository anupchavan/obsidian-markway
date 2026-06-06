import { randomUUID } from "crypto";
import { existsSync, watch } from "fs";
import type { FSWatcher } from "fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, extname, join } from "path";
import {
	FileSystemAdapter,
	Notice,
	Plugin,
	PluginSettingTab,
	requireApiVersion,
	Setting,
	TAbstractFile,
	TFile,
} from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { checkRules, firstFolderFromRules, type FrontmatterRecord } from "./rules";
import {
	journalTemplateNeedsMusic,
	journalTemplateSettingsHash,
	renderJournalBody,
	renderJournalTemplateProperties,
	stripGeneratedTitleHeading,
} from "./journal-template";
import { renderJournalTemplatePropertyRow, renderJournalTemplateSettings } from "./journal-template-ui";
import { renderJournalRules } from "./rules-ui";
import {
	DEFAULT_SETTINGS,
	canonicalPath,
	composeMarkdown,
	describeUnknown,
	explainMarkwayError,
	hashJournalContent,
	hasMatchingJournalSummary,
	isFileExistsError,
	mergeSyncOptions,
	normalizeDebounceMs,
	normalizeFolder,
	normalizePath,
	preserveMarkdownStructure,
	readPluginData,
	sameVaultPath,
	sanitizeFileName,
	sha256Hex,
	sleep,
	splitMarkdown,
	titleForFile,
	validateDebounceValue,
	vaultPathKey,
	type JournalEntrySummary,
	type JournalEntryText,
	type JournalLink,
	type MarkwayPluginData,
	type MarkwaySettings,
	type SyncOptions,
} from "./sync-utils";

type MarkwaySettingKey = keyof MarkwaySettings;

interface BridgeRequest {
	id: string;
	kind: "doctor" | "journalList" | "journalGet" | "journalPush" | "journalPull" | "journalDelete";
	relativePath?: string;
	journalID?: string;
	title?: string;
	includeMusicAttachments?: boolean;
	stripTitleHeading?: boolean;
	requestedAt: string;
}

interface BridgeResponse {
	id: string;
	ok: boolean;
	message: string;
	journalID?: string;
	entry?: JournalEntryText;
	entries?: JournalEntrySummary[];
	completedAt: string;
}

interface BridgeEvent {
	id: string;
	kind: "journalChanged";
	createdAt: string;
}

interface PushOptions {
	force?: boolean;
	silent?: boolean;
	linkedOnly?: boolean;
}

export default class MarkwayPlugin extends Plugin {
	settings: MarkwaySettings;
	journalLinks: Record<string, JournalLink> = {};
	private statusEl!: HTMLElement;
	private bridgeEventWatcher: FSWatcher | null = null;
	private bridgeRequestsInFlight = 0;
	private drainingBridgeEvents = false;
	private journalSyncInProgress = false;
	private queuedJournalSync: SyncOptions | null = null;
	private journalSyncTimer: ReturnType<typeof setTimeout> | null = null;
	private templateRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private suppressedFilePaths = new Map<string, number>();

	async onload() {
		await this.loadPluginData();

		this.statusEl = this.addStatusBarItem();
		this.setStatus("Markway idle");

		this.addSettingTab(new MarkwaySettingTab(this));
		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEvents();
			void this.registerBridgeEventWatcher();
			if (this.settings.automaticSync) {
				void this.syncJournal({ includeNew: false, silent: true });
			}
		});
		this.registerCommands();
	}

	onunload() {
		for (const timer of this.syncTimers.values()) {
			clearTimeout(timer);
		}
		this.syncTimers.clear();
		if (this.journalSyncTimer) {
			clearTimeout(this.journalSyncTimer);
			this.journalSyncTimer = null;
		}
		if (this.templateRefreshTimer) {
			clearTimeout(this.templateRefreshTimer);
			this.templateRefreshTimer = null;
		}
		this.bridgeEventWatcher?.close();
		this.bridgeEventWatcher = null;
	}

	async loadPluginData() {
		const loaded: unknown = await this.loadData();
		const data = readPluginData(loaded);
		this.settings = data.settings;
		this.journalLinks = data.journalLinks;
	}

	async savePluginData() {
		const data: MarkwayPluginData = {
			settings: this.settings,
			journalLinks: this.journalLinks,
		};
		await this.saveData(data);
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
			id: "sync-now",
			name: "Sync journal now",
			callback: () => {
				void this.syncJournal({ includeNew: true, migrateFrontmatter: true });
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
					void this.pushFile(file, { force: true });
				}
				return true;
			},
		});

		this.addCommand({
			id: "pull-current-file",
			name: "Pull current file from journal",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const canRun = file instanceof TFile && file.extension === "md";
				if (checking) {
					return canRun;
				}
				if (canRun && file) {
					void this.pullFile(file);
				}
				return true;
			},
		});
	}

	private registerVaultEvents() {
		this.registerEvent(this.app.vault.on("create", (file) => this.queueAutomaticPush(file)));
		this.registerEvent(this.app.vault.on("modify", (file) => this.queueAutomaticPush(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.handleDelete(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.queueAutomaticPush(file)));
	}

	private async registerBridgeEventWatcher() {
		try {
			await this.prepareBridgeDirectories();
			this.bridgeEventWatcher?.close();
			const watcher = watch(this.eventsDir(), { persistent: false }, () => {
				void this.drainBridgeEvents();
			});
			this.bridgeEventWatcher = watcher;
			this.register(() => watcher.close());
			void this.drainBridgeEvents();
		} catch (error) {
			this.reportError("Markway event watcher failed", error);
		}
	}

	private async drainBridgeEvents() {
		if (this.drainingBridgeEvents) {
			return;
		}

		this.drainingBridgeEvents = true;
		try {
			const names = await readdir(this.eventsDir()).catch(() => []);
			let sawJournalChange = false;
			for (const name of names) {
				if (!name.endsWith(".json")) {
					continue;
				}

				const eventPath = join(this.eventsDir(), name);
				try {
					const event = JSON.parse(await readFile(eventPath, "utf8")) as BridgeEvent;
					if (event.kind === "journalChanged") {
						sawJournalChange = true;
					}
				} catch (error) {
					console.debug("Could not read Markway bridge event", eventPath, error);
				} finally {
					await rm(eventPath, { force: true });
				}
			}

			if (sawJournalChange) {
				this.queueAutomaticJournalPull();
			}
		} finally {
			this.drainingBridgeEvents = false;
		}
	}

	private queueAutomaticJournalPull() {
		if (!this.settings.automaticSync) {
			return;
		}

		if (this.journalSyncTimer) {
			clearTimeout(this.journalSyncTimer);
		}

		const delay = Math.max(1200, this.settings.debounceMs);
		this.journalSyncTimer = setTimeout(() => {
			this.journalSyncTimer = null;
			if (this.bridgeRequestsInFlight > 0) {
				this.queueAutomaticJournalPull();
				return;
			}
			void this.syncJournal({ includeNew: true, silent: true });
		}, delay);
	}

	queueTemplateRefresh() {
		if (!this.settings.automaticSync) {
			return;
		}

		if (this.templateRefreshTimer) {
			clearTimeout(this.templateRefreshTimer);
		}

		this.templateRefreshTimer = setTimeout(() => {
			this.templateRefreshTimer = null;
			void this.syncJournal({ includeNew: false, silent: true });
		}, Math.max(1200, this.settings.debounceMs));
	}

	private queueAutomaticPush(file: TAbstractFile) {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}
		if (!this.settings.automaticSync || this.isSuppressed(file.path)) {
			return;
		}
		if (!this.fileMatchesJournalRules(file)) {
			return;
		}

		const existingTimer = this.syncTimers.get(file.path);
		if (existingTimer) {
			clearTimeout(existingTimer);
		}

		const timer = setTimeout(() => {
			this.syncTimers.delete(file.path);
			void this.pushFile(file, { silent: true });
		}, Math.max(250, this.settings.debounceMs));
		this.syncTimers.set(file.path, timer);
	}

	private handleRename(file: TAbstractFile, oldPath: string) {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}

		const link = this.linkForPath(oldPath);
		if (!link) {
			this.queueAutomaticPush(file);
			return;
		}

		this.suppressFile(oldPath);
		this.suppressFile(file.path);
		link.path = file.path;
		link.title = titleForFile(file.path);
		void this.savePluginData();
		if (this.settings.automaticSync && this.fileMatchesJournalRules(file)) {
			void this.pushFile(file, { force: true, linkedOnly: true, silent: true });
		}
	}

	private handleDelete(file: TAbstractFile) {
		if (!(file instanceof TFile) || file.extension !== "md" || this.isSuppressed(file.path)) {
			return;
		}

		const link = this.linkForPath(file.path);
		if (!link) {
			return;
		}

		void (async () => {
			try {
				if (this.settings.deleteJournalEntryWhenFileDeleted) {
					await this.deleteJournalEntry(link.journalID, { silent: true });
					delete this.journalLinks[link.journalID];
					await this.savePluginData();
				}
			} catch (error) {
				this.logSilentError(`Markway delete failed for ${file.path}`, error);
			}
		})();
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
			`bridge: ${this.safeValue(() => this.bridgeRoot())}`,
			`bridge requests exist: ${this.safeValue(() => String(existsSync(this.requestsDir())))}`,
			`automatic sync: ${this.settings.automaticSync ? "on" : "off"}`,
			`journal links: ${Object.keys(this.journalLinks).length}`,
			`active file: ${this.app.workspace.getActiveFile()?.path ?? "(none)"}`,
		];
		const message = lines.join("\n");
		this.setStatus("Markway diagnostics ready");
		new Notice(message, 12000);
		console.debug(message);
	}

	private async pushFile(file: TFile, options: PushOptions = {}) {
		this.bridgeRequestsInFlight += 1;
		try {
			await this.migrateFrontmatterLink(file);
			const link = this.linkForFile(file);
			if (options.linkedOnly && !link) {
				return;
			}

			const title = titleForFile(file.path);
			const markdown = await this.app.vault.read(file);
			const markdownHash = sha256Hex(markdown);
			if (!options.force && link && link.lastMarkdownHash === markdownHash && link.title === title) {
				this.setStatus(`Markway skipped unchanged ${file.path}`);
				return;
			}

			const journalBody = this.bodyForJournalPush(markdown, title);
			const journalHash = hashJournalContent(title, journalBody);
			const result = await this.sendBridgeRequest({
				kind: "journalPush",
				relativePath: file.path,
				journalID: link?.journalID,
				title,
				stripTitleHeading: this.settings.journalIncludeTitleHeading,
			});
			if (!result.ok || !result.journalID) {
				throw new Error(result.message || "Markway app did not return a Journal ID.");
			}

			this.journalLinks[result.journalID] = {
				journalID: result.journalID,
				path: file.path,
				title,
				lastSyncedAt: new Date().toISOString(),
				lastMarkdownHash: markdownHash,
				lastJournalHash: journalHash,
					lastJournalUpdated: "",
					lastTemplateHash: link?.lastTemplateHash ?? "",
					lastTemplateSettingsHash: link?.lastTemplateSettingsHash ?? "",
					lastTemplatePropertyKeys: link?.lastTemplatePropertyKeys ?? [],
				};
			await this.savePluginData();

			this.setStatus(`Markway pushed ${file.path}`);
			if (!options.silent) {
				new Notice(`Pushed ${file.path}`);
			}
		} catch (error) {
			if (options.silent) {
				this.logSilentError(`Markway push failed for ${file.path}`, error);
			} else {
				this.reportError(`Markway push failed for ${file.path}`, error);
			}
		} finally {
			this.bridgeRequestsInFlight = Math.max(0, this.bridgeRequestsInFlight - 1);
		}
	}

	private async pullFile(file: TFile) {
		try {
			await this.migrateFrontmatterLink(file);
			const link = this.linkForFile(file);
			if (!link) {
				throw new Error(`${file.path} is not linked to a Journal entry yet.`);
			}

			const entry = await this.getJournalEntry(link.journalID);
			await this.writeJournalEntryToVault(entry, link);
			this.setStatus(`Markway pulled ${entry.title || entry.id}`);
			new Notice(`Pulled ${entry.title || file.path}`);
		} catch (error) {
			this.reportError(`Markway pull failed for ${file.path}`, error);
		}
	}

	private async syncJournal(options: SyncOptions) {
		if (this.journalSyncInProgress) {
			this.queuedJournalSync = mergeSyncOptions(this.queuedJournalSync, options);
			return;
		}

		this.journalSyncInProgress = true;
		try {
			if (options.migrateFrontmatter) {
				await this.migrateVaultFrontmatterLinks();
			}
			const summaries = await this.listJournalEntries();
			const reservedPaths = this.reservedMarkdownPaths();
			let pulled = 0;
			let skipped = 0;

			for (const summary of summaries) {
				if (summary.status !== "active") {
					const existing = this.journalLinks[summary.id];
					if (existing && this.settings.deleteMarkdownFileWhenJournalDeleted) {
						await this.deleteMarkdownFileForJournalLink(existing);
						delete this.journalLinks[summary.id];
					}
					skipped += 1;
					continue;
				}

				const existing = this.journalLinks[summary.id];
				if (!existing && !options.includeNew) {
					skipped += 1;
					continue;
				}
				if (existing && await this.hasUnsyncedLocalChanges(existing)) {
					const file = this.fileForPath(existing.path);
					if (file && this.needsTemplateRefresh(existing)) {
						const entry = await this.getJournalEntry(summary.id);
						const templateState = await this.applyJournalTemplateProperties(file, entry);
						existing.lastTemplateHash = templateState.hash;
						existing.lastTemplateSettingsHash = templateState.settingsHash;
						existing.lastTemplatePropertyKeys = templateState.propertyKeys;
						existing.lastSyncedAt = new Date().toISOString();
					}
					if (file && this.settings.automaticSync && this.fileMatchesJournalRules(file)) {
						this.queueAutomaticPush(file);
					}
					skipped += 1;
					continue;
				}
				if (existing && hasMatchingJournalSummary(existing, summary) && !this.needsTemplateRefresh(existing)) {
					skipped += 1;
					continue;
				}

				const entry = await this.getJournalEntry(summary.id);
				const journalHash = hashJournalContent(entry.title, entry.body);
				if (existing && existing.lastJournalHash === journalHash && existing.title === entry.title) {
					existing.lastJournalUpdated = entry.updated || summary.updated || existing.lastJournalUpdated;
					existing.lastSyncedAt = new Date().toISOString();
					if (!this.needsTemplateWrite(existing, entry)) {
						skipped += 1;
						continue;
					}
				}

				await this.writeJournalEntryToVault(entry, existing, reservedPaths, summary.updated);
				pulled += 1;
			}

			await this.savePluginData();
			this.setStatus(`Markway synced journal: ${pulled} pulled, ${skipped} skipped`);
			if (!options.silent) {
				new Notice(`Markway synced journal: ${pulled} pulled, ${skipped} skipped`);
			}
		} catch (error) {
			if (options.silent) {
				this.logSilentError("Markway journal sync failed", error);
			} else {
				this.reportError("Markway journal sync failed", error);
			}
		} finally {
			this.journalSyncInProgress = false;
			const queued = this.queuedJournalSync;
			this.queuedJournalSync = null;
			if (queued) {
				void this.syncJournal(queued);
			}
		}
	}

	private async writeJournalEntryToVault(
		entry: JournalEntryText,
		existing?: JournalLink,
		reservedPaths?: Set<string>,
		summaryUpdated?: string
	) {
		const desiredPath = await this.desiredPathForEntry(entry, existing);
		const currentFile = existing ? this.fileForPath(existing.path) : null;
		let file = currentFile;
		let finalPath = desiredPath;

		if (file && file.path !== desiredPath) {
			finalPath = await this.uniqueMarkdownPath(desiredPath, file.path, reservedPaths);
			file = await this.renameFileSafely(file, finalPath);
			finalPath = file?.path ?? finalPath;
		}

		const existingMarkdown = file ? await this.app.vault.read(file) : "";
		const existingParts = splitMarkdown(existingMarkdown);
		const renderedBody = renderJournalBody(entry, this.settings.journalIncludeTitleHeading);
		const mergedBody = file
			? preserveMarkdownStructure(existingParts.body, renderedBody)
			: renderedBody;
		const markdown = composeMarkdown(existingParts.frontmatter, mergedBody);

		if (file) {
			this.suppressFile(file.path);
			await this.app.vault.modify(file, markdown);
		} else {
			file = await this.createMarkdownFileSafely(desiredPath, markdown, reservedPaths);
			finalPath = file.path;
		}

		if (!file) {
			throw new Error(`Obsidian did not return the synced file: ${finalPath}`);
		}

		reservedPaths?.add(vaultPathKey(file.path));

			const templateState = await this.applyJournalTemplateProperties(file, entry);
			const markdownHash = sha256Hex(await this.app.vault.read(file));
			this.journalLinks[entry.id] = {
			journalID: entry.id,
			path: file.path,
			title: entry.title,
			lastSyncedAt: new Date().toISOString(),
			lastMarkdownHash: markdownHash,
			lastJournalHash: hashJournalContent(entry.title, entry.body),
				lastJournalUpdated: entry.updated || summaryUpdated || "",
				lastTemplateHash: templateState.hash,
				lastTemplateSettingsHash: templateState.settingsHash,
				lastTemplatePropertyKeys: templateState.propertyKeys,
			};
	}

	private needsTemplateRefresh(link: JournalLink): boolean {
		return link.lastTemplateSettingsHash !== journalTemplateSettingsHash(this.settings);
	}

	private needsTemplateWrite(link: JournalLink, entry: JournalEntryText): boolean {
		const rendered = renderJournalTemplateProperties(entry, this.settings);
		return link.lastTemplateHash !== rendered.hash;
	}

	private async applyJournalTemplateProperties(
		file: TFile,
		entry: JournalEntryText
	): Promise<{ hash: string; settingsHash: string; propertyKeys: string[] }> {
		const rendered = renderJournalTemplateProperties(entry, this.settings);
		const propertyKeys = Object.keys(rendered.properties);
		this.suppressFile(file.path);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const metadata = frontmatter as Record<string, unknown>;
			for (const [key, value] of Object.entries(rendered.properties)) {
				metadata[key] = value;
			}
		});

		return {
			hash: rendered.hash,
			settingsHash: journalTemplateSettingsHash(this.settings),
			propertyKeys,
		};
	}

	private async hasUnsyncedLocalChanges(link: JournalLink): Promise<boolean> {
		const file = this.fileForPath(link.path);
		if (!file) {
			return false;
		}

		const markdown = await this.app.vault.read(file);
		return link.lastMarkdownHash !== "" && sha256Hex(markdown) !== link.lastMarkdownHash;
	}

	private bodyForJournalPush(markdown: string, title: string): string {
		const body = splitMarkdown(markdown).body;
		return this.settings.journalIncludeTitleHeading
			? stripGeneratedTitleHeading(body, title)
			: body;
	}

	private async renameFileSafely(file: TFile, targetPath: string): Promise<TFile | null> {
		const normalizedTarget = normalizePath(targetPath);
		if (file.path === normalizedTarget) {
			return file;
		}

		if (sameVaultPath(file.path, normalizedTarget)) {
			const directory = dirname(file.path);
			const temporaryPath = await this.uniqueMarkdownPath(
				normalizePath(
					`${directory === "." ? "" : `${directory}/`}.markway-rename-${randomUUID()}.md`
				),
				file.path
			);
			this.suppressFile(file.path);
			this.suppressFile(temporaryPath);
			await this.app.fileManager.renameFile(file, temporaryPath);

			const temporaryFile = this.fileForPath(temporaryPath);
			if (!temporaryFile) {
				throw new Error(`Obsidian did not return the temporary rename file: ${temporaryPath}`);
			}

			this.suppressFile(temporaryPath);
			this.suppressFile(normalizedTarget);
			await this.app.fileManager.renameFile(temporaryFile, normalizedTarget);
			return this.fileForPath(normalizedTarget);
		}

		this.suppressFile(file.path);
		this.suppressFile(normalizedTarget);
		await this.app.fileManager.renameFile(file, normalizedTarget);
		return this.fileForPath(normalizedTarget);
	}

	private async createMarkdownFileSafely(
		desiredPath: string,
		markdown: string,
		reservedPaths?: Set<string>
	): Promise<TFile> {
		let lastError: unknown = null;
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const finalPath = await this.uniqueMarkdownPath(desiredPath, undefined, reservedPaths);
			try {
				await this.ensureFolder(dirname(finalPath));
				this.suppressFile(finalPath);
				const created = await this.app.vault.create(finalPath, markdown);
				reservedPaths?.add(vaultPathKey(created.path));
				return created;
			} catch (error) {
				lastError = error;
				if (!isFileExistsError(error)) {
					throw error;
				}
				reservedPaths?.add(vaultPathKey(finalPath));
				await sleep(100);
			}
		}

		throw lastError instanceof Error
			? lastError
			: new Error(`Could not create an unused path for ${desiredPath}`);
	}

	private async desiredPathForEntry(entry: JournalEntryText, existing?: JournalLink): Promise<string> {
		const fileName = `${sanitizeFileName(entry.title || "Journal Entry")}.md`;
		const folder = this.journalImportFolder();
		const desired = folder ? `${folder}/${fileName}` : fileName;
		if (!existing) {
			return normalizePath(desired);
		}

		const currentFolder = dirname(existing.path);
		const targetFolder = currentFolder === "." ? folder : currentFolder;
		return normalizePath(targetFolder ? `${targetFolder}/${fileName}` : fileName);
	}

	journalImportFolder(): string {
		return firstFolderFromRules(this.settings.journalRules)
			|| normalizeFolder(this.settings.journalFolder)
			|| "Journal";
	}

	private async uniqueMarkdownPath(
		desiredPath: string,
		allowedExistingPath?: string,
		reservedPaths?: Set<string>
	): Promise<string> {
		const normalized = normalizePath(desiredPath);
		if (await this.isAvailableMarkdownPath(normalized, allowedExistingPath, reservedPaths)) {
			return normalized;
		}

		const directory = dirname(normalized);
		const extension = extname(normalized);
		const stem = basename(normalized, extension);
		for (let index = 2; index < 10_000; index += 1) {
			const candidate = normalizePath(
				`${directory === "." ? "" : `${directory}/`}${stem} ${index}${extension}`
			);
			if (await this.isAvailableMarkdownPath(candidate, allowedExistingPath, reservedPaths)) {
				return candidate;
			}
		}
		throw new Error(`Could not find an unused path for ${desiredPath}`);
	}

	private async isAvailableMarkdownPath(
		path: string,
		allowedExistingPath?: string,
		reservedPaths?: Set<string>
	): Promise<boolean> {
		const normalized = normalizePath(path);
		if (sameVaultPath(normalized, allowedExistingPath)) {
			return true;
		}
		if (reservedPaths?.has(vaultPathKey(normalized))) {
			return false;
		}
		if (this.app.vault.getAbstractFileByPath(normalized)) {
			return false;
		}
		return !(await this.app.vault.adapter.exists(normalized).catch(() => false));
	}

	private async migrateFrontmatterLink(file: TFile) {
		const journalID = this.frontmatterJournalIDForFile(file);
		if (!journalID) {
			return;
		}

		const markdown = await this.app.vault.read(file);
		const title = titleForFile(file.path);
		this.journalLinks[journalID] = {
			journalID,
			path: file.path,
			title,
			lastSyncedAt: new Date().toISOString(),
			lastMarkdownHash: sha256Hex(markdown),
			lastJournalHash: hashJournalContent(title, this.bodyForJournalPush(markdown, title)),
				lastJournalUpdated: "",
				lastTemplateHash: "",
				lastTemplateSettingsHash: "",
				lastTemplatePropertyKeys: [],
			};

		this.suppressFile(file.path);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const metadata = frontmatter as Record<string, unknown>;
			delete metadata["markway.appleJournalID"];
			delete metadata["markway.lastSyncedAt"];
		});
		const updated = await this.app.vault.read(file);
		const updatedLink = this.journalLinks[journalID];
		if (updatedLink) {
			updatedLink.lastMarkdownHash = sha256Hex(updated);
		}
		await this.savePluginData();
	}

	private async migrateVaultFrontmatterLinks() {
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (this.frontmatterJournalIDForFile(file)) {
				await this.migrateFrontmatterLink(file);
			}
		}
	}

	private reservedMarkdownPaths(): Set<string> {
		const paths = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			paths.add(vaultPathKey(file.path));
		}
		for (const link of Object.values(this.journalLinks)) {
			paths.add(vaultPathKey(link.path));
		}
		return paths;
	}

	private async listJournalEntries(): Promise<JournalEntrySummary[]> {
		const result = await this.sendBridgeRequest({ kind: "journalList" }, 60_000);
		if (!result.ok || !result.entries) {
			throw new Error(result.message || "Markway app did not return Journal entries.");
		}
		return result.entries;
	}

	private async getJournalEntry(journalID: string): Promise<JournalEntryText> {
		const result = await this.sendBridgeRequest({
			kind: "journalGet",
			journalID,
			includeMusicAttachments: journalTemplateNeedsMusic(this.settings),
		}, 60_000);
		if (!result.ok || !result.entry) {
			throw new Error(result.message || `Markway app could not read Journal entry ${journalID}.`);
		}
		return result.entry;
	}

	private async deleteJournalEntry(journalID: string, options: { silent?: boolean } = {}) {
		const result = await this.sendBridgeRequest({
			kind: "journalDelete",
			journalID,
		}, 60_000);
		if (!result.ok) {
			throw new Error(result.message || `Markway app could not delete Journal entry ${journalID}.`);
		}
		this.setStatus(`Markway deleted Journal entry ${journalID}`);
		if (!options.silent) {
			new Notice("Deleted journal entry");
		}
	}

	private async deleteMarkdownFileForJournalLink(link: JournalLink) {
		const file = this.fileForPath(link.path);
		if (!file) {
			return;
		}

		this.suppressFile(file.path);
		await this.app.fileManager.trashFile(file);
		this.setStatus(`Markway deleted ${file.path}`);
	}

	private async sendBridgeRequest(
		request: Omit<BridgeRequest, "id" | "requestedAt">,
		timeoutMs = 60_000
	): Promise<BridgeResponse> {
		const id = randomUUID().toUpperCase();
		const fullRequest: BridgeRequest = {
			id,
			requestedAt: new Date().toISOString(),
			...request,
		};
		this.bridgeRequestsInFlight += 1;
		try {
			await this.prepareBridgeDirectories();

			const requestPath = join(this.requestsDir(), `${id}.json`);
			const temporaryPath = `${requestPath}.${id}.tmp`;
			await writeFile(temporaryPath, JSON.stringify(fullRequest, null, 2), {
				encoding: "utf8",
				mode: 0o600,
			});
			await chmod(temporaryPath, 0o600);
			await rename(temporaryPath, requestPath);

			this.setStatus(`Markway request queued: ${request.kind}`);
			return await this.waitForBridgeResponse(id, timeoutMs);
		} finally {
			this.bridgeRequestsInFlight = Math.max(0, this.bridgeRequestsInFlight - 1);
		}
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

	private async prepareBridgeDirectories() {
		for (const dir of [
			this.bridgeBaseDir(),
			this.bridgeRoot(),
			this.requestsDir(),
			this.responsesDir(),
			this.eventsDir(),
		]) {
			await mkdir(dir, { recursive: true, mode: 0o700 });
			await chmod(dir, 0o700);
		}
	}

	private async ensureFolder(folderPath: string) {
		const normalized = normalizeFolder(folderPath);
		if (!normalized || (await this.pathExistsInVault(normalized))) {
			return;
		}

		const parts = normalized.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (!(await this.pathExistsInVault(current))) {
				try {
					await this.app.vault.createFolder(current);
				} catch (error) {
					if (!isFileExistsError(error)) {
						throw error;
					}
				}
			}
		}
	}

	private async pathExistsInVault(path: string): Promise<boolean> {
		const normalized = normalizePath(path);
		if (this.app.vault.getAbstractFileByPath(normalized)) {
			return true;
		}
		return await this.app.vault.adapter.exists(normalized).catch(() => false);
	}

	private vaultPath(): string {
		const override = this.settings.vaultPathOverride.trim();
		if (override) {
			return canonicalPath(override);
		}

		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			return canonicalPath(adapter.getBasePath());
		}

		throw new Error("Markway needs a local desktop vault path.");
	}

	private bridgeBaseDir(): string {
		return join(homedir(), "Library", "Application Support", "Markway", "Bridge");
	}

	private bridgeRoot(): string {
		return join(this.bridgeBaseDir(), sha256Hex(this.vaultPath()));
	}

	private requestsDir(): string {
		return join(this.bridgeRoot(), "requests");
	}

	private responsesDir(): string {
		return join(this.bridgeRoot(), "responses");
	}

	private eventsDir(): string {
		return join(this.bridgeRoot(), "events");
	}

	private linkForFile(file: TFile): JournalLink | null {
		return this.linkForPath(file.path);
	}

	private linkForPath(path: string): JournalLink | null {
		const normalized = normalizePath(path);
		return Object.values(this.journalLinks).find((link) => link.path === normalized) ?? null;
	}

	private frontmatterJournalIDForFile(file: TFile): string | null {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as
			| Record<string, unknown>
			| undefined;
		const value = frontmatter?.["markway.appleJournalID"];
		return typeof value === "string" && value.trim() ? value.trim() : null;
	}

	private fileMatchesJournalRules(file: TFile): boolean {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter as
			| FrontmatterRecord
			| undefined;
		return checkRules(this.app, this.settings.journalRules, file, frontmatter);
	}

	private fileForPath(path: string): TFile | null {
		const abstractFile = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return abstractFile instanceof TFile ? abstractFile : null;
	}

	private suppressFile(path: string) {
		const duration = Math.max(5000, this.settings.debounceMs * 4);
		this.suppressedFilePaths.set(normalizePath(path), Date.now() + duration);
	}

	private isSuppressed(path: string): boolean {
		const normalized = normalizePath(path);
		const until = this.suppressedFilePaths.get(normalized);
		if (!until) {
			return false;
		}
		if (Date.now() >= until) {
			this.suppressedFilePaths.delete(normalized);
			return false;
		}
		return true;
	}

	private setStatus(text: string) {
		this.statusEl.setText(text);
	}

	private reportError(message: string, error: unknown) {
		const detail = explainMarkwayError(error);
		this.setStatus(message);
		new Notice(`${message}: ${detail}`, 12000);
		console.error(message, error);
	}

	private logSilentError(message: string, error: unknown) {
		this.setStatus(message);
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

	getSettingDefinitions(): SettingDefinitionItem<MarkwaySettingKey>[] {
		if (!requireApiVersion("1.13.0")) {
			return [];
		}

		return [
			{
				type: "page",
				name: "General",
				desc: "Sync behavior and vault connection.",
				items: [
					{
						name: "Automatic sync",
						desc: "Sync linked files after edits.",
						control: {
							type: "toggle",
							key: "automaticSync",
							defaultValue: true,
						},
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
				],
			},
			{
				type: "page",
				name: "Journal",
				desc: "Apple Journal sync options.",
				items: [
					{
						name: "Journal folder",
						desc: "Folder to use when importing Journal entries that are not already linked.",
						control: {
							type: "text",
							key: "journalFolder",
							placeholder: "Journal",
						},
					},
					{
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
									this.update();
								},
								this.plugin.journalImportFolder()
							);
						},
					},
					{
						name: "Delete Journal entries",
						desc: "When a synced Markdown file is deleted, also delete its Apple Journal entry.",
						control: {
							type: "toggle",
							key: "deleteJournalEntryWhenFileDeleted",
							defaultValue: false,
						},
					},
					{
						name: "Delete Markdown files",
						desc: "When a synced Apple Journal entry is deleted, also delete its Markdown file.",
						control: {
							type: "toggle",
							key: "deleteMarkdownFileWhenJournalDeleted",
							defaultValue: false,
						},
					},
					{
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
								this.update();
							},
						},
						onReorder: (oldIndex, newIndex) => {
							void (async () => {
								const properties = this.plugin.settings.journalProperties;
								const [moved] = properties.splice(oldIndex, 1);
								if (!moved) {
									return;
								}
									properties.splice(newIndex, 0, moved);
									await this.plugin.savePluginData();
									this.plugin.queueTemplateRefresh();
									this.update();
								})();
							},
						onDelete: (index) => {
								void (async () => {
									this.plugin.settings.journalProperties.splice(index, 1);
									await this.plugin.savePluginData();
									this.plugin.queueTemplateRefresh();
									this.update();
								})();
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
										this.update();
									},
									() => {
										this.plugin.queueTemplateRefresh();
									}
								);
							},
						})),
					},
				],
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
		}
		await this.plugin.savePluginData();
	}

	// Kept for Obsidian versions before declarative settings.
	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Sync behavior").setHeading();
		new Setting(containerEl)
			.setName("Automatic sync")
			.setDesc("Sync linked files after edits.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.automaticSync)
					.onChange(async (value) => {
						this.plugin.settings.automaticSync = value;
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl)
			.setName("Debounce")
			.setDesc("Milliseconds to wait before an automatic push.")
			.addText((text) =>
				text
					.setPlaceholder(String(DEFAULT_SETTINGS.debounceMs))
					.setValue(String(this.plugin.settings.debounceMs))
					.onChange(async (value) => {
						this.plugin.settings.debounceMs = normalizeDebounceMs(value);
						await this.plugin.savePluginData();
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
						await this.plugin.savePluginData();
					})
			);

		new Setting(containerEl).setName("Journal").setHeading();
		renderJournalSettings(containerEl, this.plugin, () => {
			// eslint-disable-next-line @typescript-eslint/no-deprecated
			this.display();
		});
	}
}

function renderJournalSettings(containerEl: HTMLElement, plugin: MarkwayPlugin, onRefresh: () => void): void {
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
		onRefresh,
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
