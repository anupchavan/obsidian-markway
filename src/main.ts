import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { basename, dirname, extname } from "path";
import {
	FileSystemAdapter,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
} from "obsidian";
import { checkRules, firstFolderFromRules, type FrontmatterRecord } from "./rules";
import { MarkwayBridgeClient, type BridgeRequest, type BridgeResponse } from "./bridge-client";
import { registerMarkwayCommands } from "./commands";
import {
	journalTemplateNeedsMusic,
	journalTemplateSettingsHash,
	renderJournalBody,
	renderJournalTemplateProperties,
	stripGeneratedTitleHeading,
} from "./journal-template";
import { MarkwaySettingTab } from "./settings";
import {
	canonicalPath,
	composeMarkdown,
	describeUnknown,
	explainMarkwayError,
	hashJournalContent,
	hasMatchingJournalSummary,
	hasUnsyncedMarkdownContent,
	isRecord,
	isFileExistsError,
	mergeSyncOptions,
	normalizeFolder,
	normalizePath,
	preserveMarkdownStructure,
	readPluginData,
	removedGeneratedMusicAttachmentIDs,
	sameVaultPath,
	sanitizeFileName,
	sha256Hex,
	sleep,
	splitMarkdown,
	titleForFile,
	vaultPathKey,
	type JournalEntrySummary,
	type JournalEntryText,
	type JournalLink,
	type MarkwayPluginData,
	type MarkwaySettings,
	type SyncOptions,
} from "./sync-utils";

interface PushOptions {
	force?: boolean;
	silent?: boolean;
	linkedOnly?: boolean;
}

export default class MarkwayPlugin extends Plugin {
	settings: MarkwaySettings;
	journalLinks: Record<string, JournalLink> = {};
	private statusEl!: HTMLElement;
	private bridge!: MarkwayBridgeClient;
	private bridgeRequestsInFlight = 0;
	private journalSyncInProgress = false;
	private queuedJournalSync: SyncOptions | null = null;
	private journalSyncTimer: ReturnType<typeof setTimeout> | null = null;
	private templateRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private syncTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private suppressedFilePaths = new Map<string, number>();
	private recentLocalFileChanges = new Map<string, number>();

	async onload() {
		await this.loadPluginData();

		this.statusEl = this.addStatusBarItem();
		this.setStatus("Markway idle");
		this.bridge = new MarkwayBridgeClient(
			() => this.vaultPath(),
			(text) => this.setStatus(text),
			(message, error) => this.reportError(message, error),
			() => {
				this.bridgeRequestsInFlight += 1;
			},
			() => {
				this.bridgeRequestsInFlight = Math.max(0, this.bridgeRequestsInFlight - 1);
			}
		);

		this.addSettingTab(new MarkwaySettingTab(this));
		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEvents();
			void this.registerBridgeEventWatcher();
			if (this.settings.automaticSync) {
				void this.syncJournal({ includeNew: false, silent: true });
			}
		});
		registerMarkwayCommands(this);
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
		this.bridge?.close();
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

	private registerVaultEvents() {
		this.registerEvent(this.app.vault.on("create", (file) => this.handleCreateOrModify(file)));
		this.registerEvent(this.app.vault.on("modify", (file) => this.handleCreateOrModify(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.handleDelete(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.handleCreateOrModify(file)));
	}

	private handleCreateOrModify(file: TAbstractFile) {
		if (file instanceof TFile && file.extension === "md" && !this.isSuppressed(file.path)) {
			this.recentLocalFileChanges.set(normalizePath(file.path), Date.now());
		}
		this.queueAutomaticPush(file);
	}

	private async registerBridgeEventWatcher() {
		await this.bridge.registerEventWatcher(() => this.queueAutomaticJournalPull());
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
		if (!this.linkForFile(file) && !this.fileMatchesJournalRules(file)) {
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

	async runDoctor() {
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

	async showDiagnostics() {
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

	async pushFile(file: TFile, options: PushOptions = {}) {
		this.bridgeRequestsInFlight += 1;
		try {
			await this.migrateFrontmatterLink(file);
			const link = this.linkForFile(file);
			if (options.linkedOnly && !link) {
				return;
			}
			if (link) {
				await this.syncRemovedMusicAttachments(file, link);
			}

			const title = titleForFile(file.path);
			const markdown = await this.app.vault.read(file);
			const journalBody = this.bodyForJournalPush(markdown, title);
			const journalHash = hashJournalContent(title, journalBody);
			if (!options.force && link && link.lastJournalHash === journalHash && link.title === title) {
				this.setStatus(`Markway skipped unchanged ${file.path}`);
				return;
			}

			const markdownHash = sha256Hex(markdown);
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
				lastTemplateProperties: link?.lastTemplateProperties ?? {},
				lastMusicPropertyItems: link?.lastMusicPropertyItems ?? {},
			};
			this.recentLocalFileChanges.delete(normalizePath(file.path));
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

	async pullFile(file: TFile) {
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

	async syncJournal(options: SyncOptions) {
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
					this.queuePushForLink(existing);
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

				if (existing && await this.hasUnsyncedLocalChanges(existing)) {
					this.queuePushForLink(existing);
					skipped += 1;
					continue;
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
			lastTemplateProperties: templateState.properties,
			lastMusicPropertyItems: templateState.musicPropertyItems,
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
	): Promise<{
		hash: string;
		settingsHash: string;
		propertyKeys: string[];
		properties: Record<string, unknown>;
		musicPropertyItems: JournalLink["lastMusicPropertyItems"];
	}> {
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
			properties: rendered.properties,
			musicPropertyItems: rendered.musicPropertyItems,
		};
	}

	private async hasUnsyncedLocalChanges(link: JournalLink): Promise<boolean> {
		const file = this.fileForPath(link.path);
		if (!file) {
			return false;
		}

		if (this.syncTimers.has(file.path) || this.isRecentlyLocallyChanged(file.path)) {
			return true;
		}

		const markdown = await this.app.vault.read(file);
		const title = titleForFile(file.path);
		return hasUnsyncedMarkdownContent(link, markdown, title, this.bodyForJournalPush(markdown, title));
	}

	private queuePushForLink(link: JournalLink) {
		if (!this.settings.automaticSync) {
			return;
		}

		const file = this.fileForPath(link.path);
		if (file) {
			this.queueAutomaticPush(file);
		}
	}

	private isRecentlyLocallyChanged(path: string): boolean {
		const normalized = normalizePath(path);
		const changedAt = this.recentLocalFileChanges.get(normalized);
		if (!changedAt) {
			return false;
		}

		const protectionWindow = Math.max(10_000, this.settings.debounceMs * 8);
		if (Date.now() - changedAt > protectionWindow) {
			this.recentLocalFileChanges.delete(normalized);
			return false;
		}

		return true;
	}

	private bodyForJournalPush(markdown: string, title: string): string {
		const body = splitMarkdown(markdown).body;
		return this.settings.journalIncludeTitleHeading
			? stripGeneratedTitleHeading(body, title)
			: body;
	}

	private async syncRemovedMusicAttachments(file: TFile, link: JournalLink): Promise<void> {
		const activeMusicKeys = new Set(
			this.settings.journalProperties
				.filter((property) => property.key.trim() && property.value.includes("{{music"))
				.map((property) => property.key.trim())
		);
		if (activeMusicKeys.size === 0) {
			return;
		}

		const frontmatter = this.frontmatterForFile(file);
		const assetIDs = new Set<string>();
		for (const [propertyKey, previousItems] of Object.entries(link.lastMusicPropertyItems)) {
			if (!activeMusicKeys.has(propertyKey) || !Object.prototype.hasOwnProperty.call(frontmatter, propertyKey)) {
				continue;
			}
			for (const assetID of removedGeneratedMusicAttachmentIDs(previousItems, frontmatter[propertyKey])) {
				assetIDs.add(assetID);
			}
		}

		if (assetIDs.size === 0) {
			return;
		}

		for (const assetID of assetIDs) {
			await this.deleteJournalAttachment(link.journalID, assetID, { silent: true });
		}

		const entry = await this.getJournalEntry(link.journalID);
		const templateState = await this.applyJournalTemplateProperties(file, entry);
		link.lastTemplateHash = templateState.hash;
		link.lastTemplateSettingsHash = templateState.settingsHash;
		link.lastTemplatePropertyKeys = templateState.propertyKeys;
		link.lastTemplateProperties = templateState.properties;
		link.lastMusicPropertyItems = templateState.musicPropertyItems;
		link.lastJournalHash = hashJournalContent(entry.title, entry.body);
		link.lastJournalUpdated = entry.updated || link.lastJournalUpdated;
		link.lastSyncedAt = new Date().toISOString();
		await this.savePluginData();
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
			lastTemplateProperties: {},
			lastMusicPropertyItems: {},
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

	private async deleteJournalAttachment(
		journalID: string,
		assetID: string,
		options: { silent?: boolean } = {}
	) {
		const result = await this.sendBridgeRequest({
			kind: "journalDeleteAttachment",
			journalID,
			assetID,
		}, 60_000);
		if (!result.ok) {
			throw new Error(result.message || `Markway app could not delete Journal attachment ${assetID}.`);
		}
		this.setStatus(`Markway deleted Journal attachment ${assetID}`);
		if (!options.silent) {
			new Notice("Deleted journal attachment");
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
		return await this.bridge.sendRequest(request, timeoutMs);
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

	private bridgeRoot(): string {
		return this.bridge.bridgeRoot();
	}

	private requestsDir(): string {
		return this.bridge.requestsDir();
	}

	private responsesDir(): string {
		return this.bridge.responsesDir();
	}

	private eventsDir(): string {
		return this.bridge.eventsDir();
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

	private frontmatterForFile(file: TFile): Record<string, unknown> {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return isRecord(frontmatter) ? frontmatter : {};
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
