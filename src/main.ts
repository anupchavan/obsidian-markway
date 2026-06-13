import { randomUUID } from "crypto";
import { basename, dirname, extname } from "path";
import {
	FileSystemAdapter,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	parseYaml,
} from "obsidian";
import { checkRules, firstFolderFromRules } from "./rules";
import { extractWikilinkTarget } from "./rules/wikilinks";
import { MarkwayBridgeClient, type BridgeRequest, type BridgeResponse } from "./bridge-client";
import { registerMarkwayCommands } from "./commands";
import {
	isEmptyFrontmatterValue,
	journalBodyContent,
	journalCreatedDateFromNoteName,
	journalNoteNameHasEmptyTitle,
	journalTemplateNeedsAttachmentMetadata,
	journalTemplateNeedsAttachments,
	journalTitleFromNoteName,
	journalTemplateNeedsMusic,
	journalTemplateNeedsPhotos,
	journalTemplateSettingsHash,
	parseJournalBodySections,
	renderJournalBodySections,
	renderJournalNoteName,
	renderJournalTemplateProperties,
	serializeJournalBody,
	stripGeneratedContentChrome,
	stripGeneratedTitleHeading,
	templateUsesAttachments,
} from "./journal-template";

import { MarkwaySettingTab } from "./settings";
import {
	addedFrontmatterValues,
	canSkipJournalEntryForSummary,
	canonicalPath,
	composeMarkdown,
	describeUnknown,
	explainMarkwayError,
	frontmatterComparableValues,
	hashJournalContent,
	hasUnsyncedMarkdownContent,
	isRecord,
	isFileExistsError,
	mergeSyncOptions,
	normalizeFolder,
	normalizePath,
	obsidianTemplateFolderFromConfig,
	preserveMarkdownStructure,
	readPluginData,
	removedGeneratedAttachmentIDs,
	sameVaultPath,
	sanitizeFileName,
	sha256Hex,
	sleep,
	splitMarkdown,
	titleForFile,
	vaultPathKey,
	isPathInObsidianTemplateFolder,
	type GeneratedAttachmentPropertyItem,
	type JournalBodySection,
	type JournalEntrySummary,
	type JournalEntryText,
	type JournalLink,
	type JournalPhotoAttachment,
	type MarkwayPluginData,
	type MarkwaySettings,
	type PendingJournalPush,
	type SyncOptions,
} from "./sync-utils";

const IMAGE_ATTACHMENT_EXTENSIONS = new Set([
	"jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "bmp", "tif", "tiff",
]);

const VIDEO_ATTACHMENT_EXTENSIONS = new Set([
	"mov", "mp4", "m4v",
]);

// Image formats Obsidian can display: https://help.obsidian.md/file-formats
const OBSIDIAN_IMAGE_EXTENSIONS = new Set([
	"avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp",
]);

interface JournalPhotoSyncResult {
	files: Record<string, string>;
	values: string[];
	items: GeneratedAttachmentPropertyItem[];
}

interface PushOptions {
	force?: boolean;
	silent?: boolean;
	linkedOnly?: boolean;
}

interface QueuedPush {
	timer: number;
}

function comparableDateValue(value: string): string {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value.trim();
}

function calendarDateString(value: Date): string {
	const year = value.getFullYear();
	const month = `${value.getMonth() + 1}`.padStart(2, "0");
	const day = `${value.getDate()}`.padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function dateOnlyFrontmatterValue(value: string, rawValue?: string | null): string | null {
	const raw = rawValue?.trim().replace(/^(['"])([\s\S]*)\1$/, "$2") ?? "";
	const rawDate = raw.match(/^(\d{4}-\d{2}-\d{2})$/)?.[1];
	if (rawDate) {
		return rawDate;
	}
	return value.trim().match(/^(\d{4}-\d{2}-\d{2})$/)?.[1] ?? null;
}

function journalBodyForPush(body: string): string {
	return body.replace(/\n+$/g, "");
}

function isMissingJournalEntryError(message: string): boolean {
	return /\b(entry not found|not found|missing journal entry)\b/i.test(message);
}

function mergePushOptions(left: PushOptions | undefined, right: PushOptions): PushOptions {
	return {
		force: left?.force === true || right.force === true,
		silent: left ? left.silent === true && right.silent === true : right.silent === true,
		linkedOnly: left ? left.linkedOnly === true && right.linkedOnly === true : right.linkedOnly === true,
	};
}

export default class MarkwayPlugin extends Plugin {
	settings!: MarkwaySettings;
	journalLinks: Record<string, JournalLink> = {};
	pendingJournalPushes: Record<string, PendingJournalPush> = {};
	private statusEl!: HTMLElement;
	private bridge!: MarkwayBridgeClient;
	private bridgeRequestsInFlight = 0;
	private journalSyncInProgress = false;
	private queuedJournalSync: SyncOptions | null = null;
	private journalSyncTimer: number | null = null;
	private templateRefreshTimer: number | null = null;
	private syncTimers = new Map<string, QueuedPush>();
	private pushesInFlight = new Map<string, Promise<void>>();
	private queuedPushesAfterInFlight = new Map<string, PushOptions>();
	private journalSettingsSyncPauseDepth = 0;
	private journalSettingsResumeTimer: number | null = null;
	private pausedJournalSync: SyncOptions | null = null;
	private pausedVaultScanNeeded = false;
	private pausedPushPaths = new Set<string>();
	private suppressedFilePaths = new Map<string, number>();
	private recentLocalFileChanges = new Map<string, number>();
	private obsidianTemplateFolder: string | null = null;

	async onload() {
		await this.loadPluginData();
		await this.refreshObsidianTemplateFolder();

		this.statusEl = this.addStatusBarItem();
		this.setStatus("Markway idle");
		this.bridge = new MarkwayBridgeClient(
			this.app.vault.adapter,
			this.manifest.id,
			(text) => this.setStatus(text),
			(message, error) => this.reportError(message, error),
			() => {
				this.bridgeRequestsInFlight += 1;
			},
			() => {
				this.bridgeRequestsInFlight = Math.max(0, this.bridgeRequestsInFlight - 1);
			}
		);
		await this.reconcilePendingJournalPushResponses();

		this.addSettingTab(new MarkwaySettingTab(this));
		if (!this.settings.syncSetupComplete) {
			new Notice("Markway is installed. Open settings to set up journal sync.", 12000);
		}
		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEvents();
			void this.registerBridgeEventWatcher();
			if (this.canRunAutomaticSync()) {
				void this.syncVaultAndJournal({ includeNew: false, silent: true });
			}
		});
		registerMarkwayCommands(this);
	}

	onunload() {
		for (const timer of this.syncTimers.values()) {
			window.clearTimeout(timer.timer);
		}
		this.syncTimers.clear();
		if (this.journalSyncTimer) {
			window.clearTimeout(this.journalSyncTimer);
			this.journalSyncTimer = null;
		}
		if (this.templateRefreshTimer) {
			window.clearTimeout(this.templateRefreshTimer);
			this.templateRefreshTimer = null;
		}
		if (this.journalSettingsResumeTimer) {
			window.clearTimeout(this.journalSettingsResumeTimer);
			this.journalSettingsResumeTimer = null;
		}
		this.bridge?.close();
	}

	async loadPluginData() {
		const loaded: unknown = await this.loadData();
		const data = readPluginData(loaded);
		this.settings = data.settings;
		this.journalLinks = data.journalLinks;
		this.pendingJournalPushes = data.pendingJournalPushes;
	}

	async savePluginData() {
		const data: MarkwayPluginData = {
			settings: this.settings,
			journalLinks: this.journalLinks,
			pendingJournalPushes: this.pendingJournalPushes,
		};
		await this.saveData(data);
	}

	async saveSettingsFromUI(options: { scanVault?: boolean; refreshJournal?: boolean } = {}) {
		const wasIncomplete = !this.settings.syncSetupComplete;
		this.settings.syncSetupComplete = true;
		await this.savePluginData();
		if (wasIncomplete || options.scanVault || options.refreshJournal) {
			this.queueSettingsChangedSync({
				includeNew: false,
				silent: true,
			}, wasIncomplete || options.scanVault === true);
		}
	}

	beginJournalSettingsSyncPause() {
		if (this.journalSettingsResumeTimer) {
			window.clearTimeout(this.journalSettingsResumeTimer);
			this.journalSettingsResumeTimer = null;
		}
		this.journalSettingsSyncPauseDepth += 1;
	}

	endJournalSettingsSyncPause() {
		this.journalSettingsSyncPauseDepth = Math.max(0, this.journalSettingsSyncPauseDepth - 1);
		if (this.journalSettingsSyncPauseDepth > 0) {
			return;
		}
		if (this.journalSettingsResumeTimer) {
			window.clearTimeout(this.journalSettingsResumeTimer);
		}
		this.journalSettingsResumeTimer = window.setTimeout(() => {
			this.journalSettingsResumeTimer = null;
			if (this.journalSettingsSyncPauseDepth === 0) {
				this.flushJournalSettingsSyncQueue();
			}
		}, 0);
	}

	private flushJournalSettingsSyncQueue() {
		const queued = this.pausedJournalSync;
		const scanVault = this.pausedVaultScanNeeded;
		const pushPaths = new Set(this.pausedPushPaths);
		this.pausedJournalSync = null;
		this.pausedVaultScanNeeded = false;
		this.pausedPushPaths.clear();
		if ((!queued && !scanVault && !pushPaths.size) || !this.canRunAutomaticSync()) {
			return;
		}

		void this.flushJournalSettingsPausedSync(queued ?? { includeNew: false, silent: true }, scanVault, pushPaths);
	}

	private canRunAutomaticSync(): boolean {
		return this.settings.automaticSync && this.settings.syncSetupComplete;
	}

	private isJournalSettingsSyncPaused(): boolean {
		return this.journalSettingsSyncPauseDepth > 0;
	}

	private queueSettingsChangedSync(options: SyncOptions, scanVault: boolean) {
		if (!this.canRunAutomaticSync()) {
			return;
		}
		if (this.queueSyncUntilJournalSettingsClose(options, scanVault)) {
			return;
		}
		if (scanVault) {
			void this.syncVaultAndJournal(options);
		} else {
			void this.syncJournal(options);
		}
	}

	private queueSyncUntilJournalSettingsClose(options: SyncOptions, scanVault: boolean): boolean {
		if (!this.isJournalSettingsSyncPaused()) {
			return false;
		}
		this.pausedJournalSync = mergeSyncOptions(this.pausedJournalSync, options);
		this.pausedVaultScanNeeded = this.pausedVaultScanNeeded || scanVault;
		return true;
	}

	private queueFilePushUntilJournalSettingsClose(file: TFile): boolean {
		if (!this.isJournalSettingsSyncPaused()) {
			return false;
		}
		this.pausedPushPaths.add(normalizePath(file.path));
		this.pausedJournalSync = mergeSyncOptions(this.pausedJournalSync, { includeNew: false, silent: true });
		return true;
	}

	private async flushJournalSettingsPausedSync(
		options: SyncOptions,
		scanVault: boolean,
		pushPaths: Set<string>
	) {
		await this.refreshObsidianTemplateFolder();
		if (scanVault) {
			await this.syncExistingVaultFiles({ silent: true });
		}
		for (const path of [...pushPaths].sort()) {
			const file = this.fileForPath(path);
			if (!file) {
				continue;
			}
			if (
				this.isObsidianTemplateFile(file)
				|| this.hasPendingJournalPushForPath(file.path)
				|| (!this.linkForFile(file) && !this.fileMatchesJournalRules(file))
			) {
				continue;
			}
			await this.pushFile(file, { silent: true });
		}
		await this.syncJournal(options);
	}

	private registerVaultEvents() {
		this.registerEvent(this.app.vault.on("create", (file) => this.handleCreateOrModify(file)));
		this.registerEvent(this.app.vault.on("modify", (file) => this.handleCreateOrModify(file)));
		this.registerEvent(this.app.vault.on("delete", (file) => this.handleDelete(file)));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => this.handleCreateOrModify(file)));
	}

	private handleCreateOrModify(file: TAbstractFile) {
		if (
			file instanceof TFile
			&& file.extension === "md"
			&& !this.isSuppressed(file.path)
			&& !this.isObsidianTemplateFile(file)
		) {
			this.recentLocalFileChanges.set(normalizePath(file.path), Date.now());
		}
		this.queueAutomaticPush(file);
	}

	private async registerBridgeEventWatcher() {
		await this.bridge.registerEventWatcher(() => this.queueAutomaticJournalPull());
	}

	private queueAutomaticJournalPull() {
		if (!this.canRunAutomaticSync()) {
			return;
		}
		if (this.queueSyncUntilJournalSettingsClose({ includeNew: true, silent: true }, false)) {
			return;
		}

		if (this.journalSyncTimer) {
			window.clearTimeout(this.journalSyncTimer);
		}

		const delay = Math.max(1200, this.settings.debounceMs);
		this.journalSyncTimer = window.setTimeout(() => {
			this.journalSyncTimer = null;
			if (this.bridgeRequestsInFlight > 0) {
				this.queueAutomaticJournalPull();
				return;
			}
			if (this.queueSyncUntilJournalSettingsClose({ includeNew: true, silent: true }, false)) {
				return;
			}
			void this.syncJournal({ includeNew: true, silent: true });
		}, delay);
	}

	queueTemplateRefresh() {
		if (!this.canRunAutomaticSync()) {
			return;
		}
		if (this.queueSyncUntilJournalSettingsClose({ includeNew: false, silent: true }, false)) {
			return;
		}

		if (this.templateRefreshTimer) {
			window.clearTimeout(this.templateRefreshTimer);
		}

		this.templateRefreshTimer = window.setTimeout(() => {
			this.templateRefreshTimer = null;
			if (this.queueSyncUntilJournalSettingsClose({ includeNew: false, silent: true }, false)) {
				return;
			}
			void this.syncJournal({ includeNew: false, silent: true });
		}, Math.max(1200, this.settings.debounceMs));
	}

	private queueAutomaticPush(file: TAbstractFile) {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}
		if (
			!this.canRunAutomaticSync()
			|| this.isSuppressed(file.path)
			|| this.isObsidianTemplateFile(file)
			|| this.hasPendingJournalPushForPath(file.path)
		) {
			return;
		}
		if (!this.linkForFile(file) && (!this.fileMatchesJournalRules(file) || this.hasEmptyTemplatedTitle(file))) {
			return;
		}
		if (this.queueFilePushUntilJournalSettingsClose(file)) {
			return;
		}

		const path = normalizePath(file.path);
		const existingTimer = this.syncTimers.get(path);
		if (existingTimer) {
			window.clearTimeout(existingTimer.timer);
		}

		const timer = window.setTimeout(() => {
			this.syncTimers.delete(path);
			const currentFile = this.fileForPath(path);
			if (!currentFile || this.isSuppressed(path) || this.isObsidianTemplateFile(currentFile)) {
				return;
			}
			if (
				!this.linkForFile(currentFile)
				&& (!this.fileMatchesJournalRules(currentFile) || this.hasEmptyTemplatedTitle(currentFile))
			) {
				return;
			}
			if (this.queueFilePushUntilJournalSettingsClose(currentFile)) {
				return;
			}
			void this.pushFile(currentFile, { silent: true });
		}, Math.max(250, this.settings.debounceMs));
		this.syncTimers.set(path, { timer });
	}

	private handleRename(file: TAbstractFile, oldPath: string) {
		if (!(file instanceof TFile) || file.extension !== "md") {
			return;
		}

		this.cancelQueuedPush(oldPath);
		this.moveRecentLocalChange(oldPath, file.path);
		const link = this.linkForPath(oldPath);
		if (!link) {
			this.queueAutomaticPush(file);
			return;
		}

		this.suppressFile(oldPath);
		this.suppressFile(file.path);
		link.path = file.path;
		link.title = this.journalTitleForFile(file.path);
		void this.savePluginData();
		if (this.canRunAutomaticSync() && !this.isObsidianTemplateFile(file) && this.fileMatchesJournalRules(file)) {
			if (this.queueFilePushUntilJournalSettingsClose(file)) {
				return;
			}
			void this.pushFile(file, { force: true, linkedOnly: true, silent: true });
		}
	}

	private handleDelete(file: TAbstractFile) {
		if (
			!(file instanceof TFile)
			|| file.extension !== "md"
			|| this.isSuppressed(file.path)
			|| this.isObsidianTemplateFile(file)
		) {
			return;
		}
		if (!this.canRunAutomaticSync() || this.isJournalSettingsSyncPaused()) {
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
		const bridgeRequestsExist = await this.safeAsyncValue(async () => String(await this.bridge.requestsExist()));
		const lines = [
			`vault: ${this.safeValue(() => this.vaultPath())}`,
			`bridge: ${this.safeValue(() => this.bridgeRoot())}`,
			`bridge requests exist: ${bridgeRequestsExist}`,
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
		const path = normalizePath(file.path);
		const inFlight = this.pushesInFlight.get(path);
		if (inFlight) {
			this.queuedPushesAfterInFlight.set(
				path,
				mergePushOptions(this.queuedPushesAfterInFlight.get(path), options)
			);
			await inFlight;
			return;
		}

		const push = this.pushFileNow(file, options).finally(async () => {
			this.pushesInFlight.delete(path);
			const queued = this.queuedPushesAfterInFlight.get(path);
			this.queuedPushesAfterInFlight.delete(path);
			if (!queued) {
				return;
			}
			const currentFile = this.fileForPath(path);
			if (currentFile) {
				await this.pushFile(currentFile, queued);
			}
		});
		this.pushesInFlight.set(path, push);
		await push;
	}

	private async pushFileNow(file: TFile, options: PushOptions = {}) {
		this.bridgeRequestsInFlight += 1;
		try {
			await this.refreshObsidianTemplateFolder();
			if (this.isObsidianTemplateFile(file)) {
				this.setStatus(`Markway skipped Obsidian template ${file.path}`);
				return;
			}
			await this.migrateFrontmatterLink(file);
			const link = this.linkForFile(file);
			if (options.linkedOnly && !link) {
				return;
			}
			if (link) {
				await this.syncGeneratedAttachmentEdits(file, link);
			}

			const title = this.journalTitleForFile(file.path);
			const markdown = await this.app.vault.read(file);
			const journalBody = this.bodyForJournalPush(markdown, title, link);
			const journalHash = hashJournalContent(title, journalBody);
			const createdUpdate = this.journalCreatedDateForPush(file, markdown, link);
			if (!options.force && link && link.lastJournalHash === journalHash && link.title === title && !createdUpdate) {
				this.setStatus(`Markway skipped unchanged ${file.path}`);
				return;
			}

			const markdownHash = sha256Hex(markdown);
			const requestID = crypto.randomUUID().toUpperCase();
			this.pendingJournalPushes[requestID] = this.pendingJournalPushForRequest(
				requestID,
				file,
				title,
				link,
				markdownHash,
				journalHash,
				createdUpdate
			);
			await this.savePluginData();
			const result = await this.sendBridgeRequest({
				kind: "journalPush",
				relativePath: file.path,
				journalID: link?.journalID,
				title,
				created: createdUpdate?.value,
				createIfMissing: !link || !this.settings.deleteMarkdownFileWhenJournalDeleted,
				// Send the extracted journal text; Markway.app must not push the
				// raw file, which contains generated template sections.
				body: journalBody,
				stripTitleHeading: this.settings.journalIncludeTitleHeading,
			}, 60_000, requestID);
			if (!result.ok || !result.journalID) {
				delete this.pendingJournalPushes[requestID];
				if (link && this.settings.deleteMarkdownFileWhenJournalDeleted && isMissingJournalEntryError(result.message)) {
					await this.deleteMarkdownFileForJournalLink(link);
					delete this.journalLinks[link.journalID];
					await this.savePluginData();
					return;
				}
				await this.savePluginData();
				throw new Error(result.message || "Markway app did not return a Journal ID.");
			}

			const pendingPush = this.pendingJournalPushes[requestID];
			if (!pendingPush) {
				throw new Error(`Missing pending Journal push state for ${requestID}.`);
			}
			this.applyCompletedJournalPush(pendingPush, result.journalID);
			delete this.pendingJournalPushes[requestID];
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

	private pendingJournalPushForRequest(
		requestID: string,
		file: TFile,
		title: string,
		link: JournalLink | null,
		markdownHash: string,
		journalHash: string,
		createdUpdate?: { key: string; value: string } | null
	): PendingJournalPush {
		const lastTemplatePropertyKeys = [...(link?.lastTemplatePropertyKeys ?? [])];
		const lastTemplateProperties = { ...(link?.lastTemplateProperties ?? {}) };
		if (createdUpdate && !lastTemplatePropertyKeys.includes(createdUpdate.key)) {
			lastTemplatePropertyKeys.push(createdUpdate.key);
		}
		if (createdUpdate) {
			lastTemplateProperties[createdUpdate.key] = createdUpdate.value;
		}

		return {
			requestID,
			path: file.path,
			title,
			existingJournalID: link?.journalID ?? "",
			created: createdUpdate?.value ?? "",
			createdKey: createdUpdate?.key ?? "",
			markdownHash,
			journalHash,
			lastJournalCreated: link?.lastJournalCreated ?? "",
			lastJournalUpdated: "",
			lastTemplateHash: link?.lastTemplateHash ?? "",
			lastTemplateSettingsHash: link?.lastTemplateSettingsHash ?? "",
			lastTemplatePropertyKeys,
			lastTemplateProperties,
			lastAttachmentPropertyItems: link?.lastAttachmentPropertyItems ?? {},
			lastContentPrefix: link?.lastContentPrefix ?? "",
			lastContentSuffix: link?.lastContentSuffix ?? "",
			lastBodySections: link?.lastBodySections ?? [],
			lastPhotoFiles: link?.lastPhotoFiles ?? {},
		};
	}

	private async reconcilePendingJournalPushResponses(): Promise<void> {
		const responseIDs = await this.bridge.listResponseIDs();
		let changed = false;
		const repairPaths = new Set<string>();
		for (const responseID of responseIDs) {
			const pending = this.pendingJournalPushes[responseID];
			if (!pending) {
				continue;
			}

			let response: BridgeResponse | null = null;
			try {
				response = await this.bridge.consumeResponse(responseID);
			} catch (error) {
				this.logSilentError(`Markway could not recover pending push ${pending.path}`, error);
			}
			if (!response) {
				continue;
			}

			delete this.pendingJournalPushes[responseID];
			changed = true;
			if (!response.ok) {
				if (this.settings.deleteMarkdownFileWhenJournalDeleted && isMissingJournalEntryError(response.message)) {
					await this.deleteMarkdownFileForPendingPush(pending);
				}
				continue;
			}
			if (!response.journalID) {
				continue;
			}

			this.applyCompletedJournalPush(pending, response.journalID);
			repairPaths.add(pending.path);
		}

		if (changed) {
			await this.savePluginData();
		}

		for (const path of repairPaths) {
			const file = this.fileForPath(path);
			if (!file) {
				continue;
			}
			const markdown = await this.app.vault.read(file);
			const link = this.linkForFile(file);
			if (link && this.journalCreatedDateForPush(file, markdown, link)) {
				this.queueAutomaticPush(file);
			}
		}
	}

	private applyCompletedJournalPush(pending: PendingJournalPush, journalID: string): void {
		if (pending.existingJournalID && pending.existingJournalID !== journalID) {
			delete this.journalLinks[pending.existingJournalID];
		}
		this.journalLinks[journalID] = {
			journalID,
			path: pending.path,
			title: pending.title,
			lastSyncedAt: new Date().toISOString(),
			lastJournalCreated: pending.created || pending.lastJournalCreated,
			lastMarkdownHash: pending.markdownHash,
			lastJournalHash: pending.journalHash,
			lastJournalUpdated: pending.lastJournalUpdated,
			lastTemplateHash: pending.lastTemplateHash,
			lastTemplateSettingsHash: pending.lastTemplateSettingsHash,
			lastTemplatePropertyKeys: pending.lastTemplatePropertyKeys,
			lastTemplateProperties: pending.lastTemplateProperties,
			lastAttachmentPropertyItems: pending.lastAttachmentPropertyItems,
			lastContentPrefix: pending.lastContentPrefix,
			lastContentSuffix: pending.lastContentSuffix,
			lastBodySections: pending.lastBodySections,
			lastPhotoFiles: pending.lastPhotoFiles,
		};
		this.recentLocalFileChanges.delete(normalizePath(pending.path));
	}

	private async deleteMarkdownFileForPendingPush(pending: PendingJournalPush): Promise<void> {
		if (pending.existingJournalID) {
			delete this.journalLinks[pending.existingJournalID];
		}
		const file = this.fileForPath(pending.path);
		if (!file) {
			return;
		}
		this.suppressFile(file.path);
		await this.app.fileManager.trashFile(file);
		this.setStatus(`Markway deleted ${file.path}`);
	}

	async pullFile(file: TFile) {
		try {
			await this.refreshObsidianTemplateFolder();
			if (this.isObsidianTemplateFile(file)) {
				throw new Error(`${file.path} is an Obsidian template file and is excluded from Journal sync.`);
			}
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

	async syncVaultAndJournal(options: SyncOptions) {
		if (this.queueSyncUntilJournalSettingsClose(options, true)) {
			return;
		}
		await this.syncExistingVaultFiles({ silent: true });
		await this.syncJournal(options);
	}

	private async syncExistingVaultFiles(options: { silent?: boolean } = {}) {
		await this.refreshObsidianTemplateFolder();
		const files = [...this.app.vault.getMarkdownFiles()].sort((left, right) => left.path.localeCompare(right.path));
		let pushed = 0;
		let skipped = 0;

		for (const file of files) {
			if (
				this.isSuppressed(file.path)
				|| this.isObsidianTemplateFile(file)
				|| this.hasPendingJournalPushForPath(file.path)
				|| this.linkForFile(file)
				|| !this.fileMatchesJournalRules(file)
			) {
				skipped += 1;
				continue;
			}
			await this.pushFile(file, { silent: true });
			pushed += 1;
		}

		this.setStatus(`Markway scanned vault: ${pushed} pushed, ${skipped} skipped`);
		if (!options.silent && pushed > 0) {
			new Notice(`Markway pushed ${pushed} existing ${pushed === 1 ? "note" : "notes"}`);
		}
	}

	async syncJournal(options: SyncOptions) {
		if (this.queueSyncUntilJournalSettingsClose(options, false)) {
			return;
		}
		if (this.journalSyncInProgress) {
			this.queuedJournalSync = mergeSyncOptions(this.queuedJournalSync, options);
			return;
		}

		this.journalSyncInProgress = true;
		try {
			await this.refreshObsidianTemplateFolder();
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
				if (existing && this.isObsidianTemplatePath(existing.path)) {
					skipped += 1;
					continue;
				}
				if (!existing && !options.includeNew) {
					skipped += 1;
					continue;
				}
				if (existing) {
					existing.lastJournalCreated = summary.created || existing.lastJournalCreated || "";
				}
				if (existing && await this.hasUnsyncedLocalChanges(existing)) {
					this.queuePushForLink(existing);
					skipped += 1;
					continue;
				}
				if (existing && await this.needsJournalCreatedPush(existing)) {
					this.queuePushForLink(existing);
					skipped += 1;
					continue;
				}
				if (existing && canSkipJournalEntryForSummary(existing, summary, {
					templateNeedsRefresh: this.needsTemplateRefresh(existing),
					metadataNeedsRefresh: journalTemplateNeedsAttachmentMetadata(this.settings),
				})) {
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

		// Download photos before rendering, so templates see the converted
		// vault file names instead of Journal-internal store paths.
		const photosKey = this.settings.journalPhotosProperty.trim();
		const photoSync = photosKey
			? await this.syncJournalPhotoFiles(file?.path ?? desiredPath, entry, existing?.lastPhotoFiles ?? {})
			: null;
		const photoFiles = photoSync?.files ?? existing?.lastPhotoFiles ?? {};

		const renderedSections = renderJournalBodySections(entry, this.settings, photoFiles);
		const previousLayout = existing?.lastBodySections ?? [];

		let mergedContent = entry.body;
		let existingSections: JournalBodySection[] | null = null;
		if (file) {
			let existingBody = existingParts.body;
			if (this.settings.journalIncludeTitleHeading) {
				existingBody = stripGeneratedTitleHeading(existingBody, existing?.title ?? entry.title);
			}
			existingSections = previousLayout.length > 0
				? parseJournalBodySections(existingBody, previousLayout)
				: null;
			const existingContent = existingSections
				? existingSections.find((section) => section.kind === "content")?.text ?? existingBody
				: stripGeneratedContentChrome(
					existingBody,
					existing?.lastContentPrefix ?? "",
					existing?.lastContentSuffix ?? ""
				);
			mergedContent = preserveMarkdownStructure(existingContent, entry.body);
		}

		// A generated section the user edited stays theirs; clean sections
		// refresh with the new render.
		const layoutUnchanged = existingSections !== null
			&& previousLayout.length === renderedSections.length
			&& previousLayout.every((section, index) =>
				section.kind === renderedSections[index]?.kind && section.marker === renderedSections[index]?.marker);
		const finalSections = renderedSections.map((section, index) => {
			if (section.kind === "content") {
				return { ...section, text: mergedContent };
			}
			if (layoutUnchanged && existingSections) {
				const currentText = existingSections[index]?.text ?? "";
				const lastRenderedText = previousLayout[index]?.text ?? "";
				if (currentText.trim() !== lastRenderedText.trim()) {
					return { ...section, text: currentText };
				}
			}
			return section;
		});

		const heading = this.settings.journalIncludeTitleHeading && entry.title.trim()
			? `# ${entry.title.trim()}\n\n`
			: "";
		const renderedBody = `${heading}${serializeJournalBody(finalSections)}`;
		const markdown = composeMarkdown(existingParts.frontmatter, renderedBody);

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

		const templateState = await this.applyJournalTemplateProperties(
			file,
			entry,
			existing?.lastPhotoFiles ?? {},
			photoSync
		);
		const trackedTemplateState = this.withPushOnlyTemplateProperties(existing, templateState);
		const markdownHash = sha256Hex(await this.app.vault.read(file));
		this.journalLinks[entry.id] = {
			journalID: entry.id,
			path: file.path,
				title: entry.title,
				lastSyncedAt: new Date().toISOString(),
				lastJournalCreated: entry.created || existing?.lastJournalCreated || "",
				lastMarkdownHash: markdownHash,
				lastJournalHash: hashJournalContent(entry.title, entry.body),
			lastJournalUpdated: entry.updated || summaryUpdated || "",
			lastTemplateHash: templateState.hash,
			lastTemplateSettingsHash: templateState.settingsHash,
			lastTemplatePropertyKeys: trackedTemplateState.propertyKeys,
			lastTemplateProperties: trackedTemplateState.properties,
			lastAttachmentPropertyItems: templateState.attachmentPropertyItems,
			lastContentPrefix: "",
			lastContentSuffix: "",
			lastBodySections: renderedSections.map((section) => ({
				kind: section.kind,
				marker: section.marker,
				text: section.kind === "generated" ? section.text : "",
			})),
			lastPhotoFiles: templateState.photoFiles,
		};
	}

	private needsTemplateRefresh(link: JournalLink): boolean {
		return link.lastTemplateSettingsHash !== journalTemplateSettingsHash(this.settings);
	}

	private needsTemplateWrite(link: JournalLink, entry: JournalEntryText): boolean {
		const rendered = renderJournalTemplateProperties(entry, this.settings, new Date(), link.lastPhotoFiles);
		if (link.lastTemplateHash !== rendered.hash) {
			return true;
		}

		const sections = renderJournalBodySections(entry, this.settings, link.lastPhotoFiles);
		const stored = link.lastBodySections;
		const sectionsChanged = sections.length !== stored.length
			|| sections.some((section, index) => {
				const previous = stored[index];
				return !previous
					|| previous.kind !== section.kind
					|| previous.marker !== section.marker
					|| (section.kind === "generated" && previous.text !== section.text);
			});
		if (sectionsChanged) {
			return true;
		}

		const photosKey = this.settings.journalPhotosProperty.trim();
		if (!photosKey) {
			return false;
		}
		const knownIDs = (link.lastAttachmentPropertyItems[photosKey] ?? []).map((item) => item.id);
		const entryIDs = (entry.photoAttachments ?? []).map((photo) => photo.id);
		return knownIDs.join("\n") !== entryIDs.join("\n");
	}

	private async applyJournalTemplateProperties(
		file: TFile,
		entry: JournalEntryText,
		previousPhotoFiles: Record<string, string> = {},
		precomputedPhotoSync: JournalPhotoSyncResult | null = null
	): Promise<{
		hash: string;
		settingsHash: string;
		propertyKeys: string[];
		properties: Record<string, unknown>;
		attachmentPropertyItems: JournalLink["lastAttachmentPropertyItems"];
		photoFiles: Record<string, string>;
	}> {
		const photosKey = this.settings.journalPhotosProperty.trim();
		let photoSync = precomputedPhotoSync;
		if (photosKey && !photoSync) {
			photoSync = await this.syncJournalPhotoFiles(file.path, entry, previousPhotoFiles);
		}
		const photoFiles = photoSync?.files ?? previousPhotoFiles;

		const rendered = renderJournalTemplateProperties(entry, this.settings, new Date(), photoFiles);
		const properties = { ...rendered.properties };
		const attachmentPropertyItems = { ...rendered.attachmentPropertyItems };

		if (photosKey && photoSync) {
			if (!isEmptyFrontmatterValue(photoSync.values)) {
				properties[photosKey] = photoSync.values;
			}
			if (photoSync.items.length > 0 && !isEmptyFrontmatterValue(photoSync.values)) {
				attachmentPropertyItems[photosKey] = photoSync.items;
			} else {
				delete attachmentPropertyItems[photosKey];
			}
		}

		const propertyKeys = Object.keys(properties);
		this.suppressFile(file.path);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const metadata = frontmatter as Record<string, unknown>;
			for (const [key, value] of Object.entries(properties)) {
				metadata[key] = value;
			}
		});

		return {
			hash: rendered.hash,
			settingsHash: journalTemplateSettingsHash(this.settings),
			propertyKeys,
			properties,
			attachmentPropertyItems,
			photoFiles,
		};
	}

	private async syncJournalPhotoFiles(
		notePath: string,
		entry: JournalEntryText,
		previousFiles: Record<string, string>
	): Promise<JournalPhotoSyncResult> {
		const files: Record<string, string> = {};
		const values: string[] = [];
		const items: GeneratedAttachmentPropertyItem[] = [];

		for (const [index, photo] of (entry.photoAttachments ?? []).entries()) {
			if (!photo.id) {
				continue;
			}
			const previousPath = previousFiles[photo.id];
			let path = previousPath && this.fileForPath(previousPath) ? previousPath : null;
			path ??= await this.downloadJournalPhotoFile(entry, photo, index, notePath);
			if (!path) {
				continue;
			}
			files[photo.id] = path;
			const value = `[[${basename(path)}]]`;
			values.push(value);
			items.push({ id: photo.id, value });
		}

		values.push(...this.unmanagedPhotoPropertyValues(notePath, values));
		return { files, values, items };
	}

	private withPushOnlyTemplateProperties(
		link: JournalLink | undefined,
		templateState: {
			propertyKeys: string[];
			properties: Record<string, unknown>;
		}
	): { propertyKeys: string[]; properties: Record<string, unknown> } {
		const key = this.settings.journalCreatedProperty.trim();
		if (
			!key
			|| !link
			|| Object.prototype.hasOwnProperty.call(templateState.properties, key)
			|| !Object.prototype.hasOwnProperty.call(link.lastTemplateProperties, key)
		) {
			return {
				propertyKeys: templateState.propertyKeys,
				properties: templateState.properties,
			};
		}

		return {
			propertyKeys: templateState.propertyKeys.includes(key)
				? templateState.propertyKeys
				: [...templateState.propertyKeys, key],
			properties: {
				...templateState.properties,
				[key]: link.lastTemplateProperties[key],
			},
		};
	}

	private unmanagedPhotoPropertyValues(notePath: string, generatedValues: string[]): string[] {
		const file = this.fileForPath(notePath);
		if (!file) {
			return [];
		}
		const photosKey = this.settings.journalPhotosProperty.trim();
		const link = this.linkForFile(file);
		const managed = new Set([
			...generatedValues,
			...(link?.lastAttachmentPropertyItems[photosKey] ?? []).map((item) => item.value),
		]);
		const frontmatter = this.frontmatterForFile(file);
		if (!Object.prototype.hasOwnProperty.call(frontmatter, photosKey)) {
			return [];
		}

		return frontmatterComparableValues(frontmatter[photosKey]).filter(
			(value) => !managed.has(value) && !this.resolveVaultAttachmentFile(value, file.path)
		);
	}

	private async downloadJournalPhotoFile(
		entry: JournalEntryText,
		photo: JournalPhotoAttachment,
		index: number,
		notePath: string
	): Promise<string | null> {
		const photoFiles = photo.files ?? [];
		const primary = photoFiles.find((item) => item.name === "image") ?? photoFiles[0];
		const sourcePath = primary?.relativePath || primary?.absolutePath || "";
		const sourceExtension = extname(sourcePath).replace(/^\./, "").toLowerCase();
		// Journal photos are usually HEIC, which Obsidian cannot display, so
		// Markway.app converts those to JPEG while exporting.
		const extension = OBSIDIAN_IMAGE_EXTENSIONS.has(sourceExtension) ? sourceExtension : "jpg";
		const title = sanitizeFileName(entry.title || "Journal entry");

		try {
			const destination = normalizePath(
				await this.app.fileManager.getAvailablePathForAttachment(`${title} - ${index + 1}.${extension}`, notePath)
			);
			const result = await this.sendBridgeRequest({
				kind: "journalExportAttachment",
				journalID: entry.id,
				assetID: photo.id,
				relativePath: destination,
			});
			if (!result.ok) {
				throw new Error(result.message || "Markway.app could not export the photo.");
			}
			return destination;
		} catch (error) {
			this.logSilentError(`Markway could not download Journal photo ${photo.id}`, error);
			return null;
		}
	}

	private resolveVaultAttachmentFile(value: string, sourcePath: string): TFile | null {
		const target = extractWikilinkTarget(value).trim();
		if (!target) {
			return null;
		}
		const file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
		if (!file) {
			return null;
		}
		const extension = file.extension.toLowerCase();
		return IMAGE_ATTACHMENT_EXTENSIONS.has(extension) || VIDEO_ATTACHMENT_EXTENSIONS.has(extension)
			? file
			: null;
	}

	private async hasUnsyncedLocalChanges(link: JournalLink): Promise<boolean> {
		const file = this.fileForPath(link.path);
		if (!file || this.isObsidianTemplateFile(file)) {
			return false;
		}

		if (this.syncTimers.has(normalizePath(file.path)) || this.isRecentlyLocallyChanged(file.path)) {
			return true;
		}

		const markdown = await this.app.vault.read(file);
		const title = this.journalTitleForFile(file.path);
		return hasUnsyncedMarkdownContent(link, markdown, title, this.bodyForJournalPush(markdown, title, link));
	}

	private async needsJournalCreatedPush(link: JournalLink): Promise<boolean> {
		if (!this.settings.journalCreatedProperty.trim() || !link.lastJournalCreated) {
			return false;
		}
		const file = this.fileForPath(link.path);
		if (!file || this.isObsidianTemplateFile(file)) {
			return false;
		}

		const markdown = await this.app.vault.read(file);
		return this.journalCreatedDateForPush(file, markdown, link) !== null;
	}

	private queuePushForLink(link: JournalLink) {
		if (!this.canRunAutomaticSync()) {
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

	private journalTitleForFile(path: string): string {
		return journalTitleFromNoteName(titleForFile(path), this.settings.journalNoteNameTemplate);
	}

	private journalCreatedDateForPush(
		file: TFile,
		markdown?: string,
		link?: JournalLink | null
	): { key: string; value: string } | null {
		const key = this.settings.journalCreatedProperty.trim();
		if (!key) {
			return null;
		}

		const parsedFrontmatter = markdown ? this.frontmatterForMarkdown(markdown) : {};
		const cachedFrontmatter = this.frontmatterForFile(file);
		const frontmatter = Object.prototype.hasOwnProperty.call(parsedFrontmatter, key)
			? parsedFrontmatter
			: cachedFrontmatter;
		if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) {
			return null;
		}
		const value = frontmatterComparableValues(frontmatter[key])[0]?.trim() ?? "";
		if (!value) {
			return null;
		}
		const created = this.createdDateValueForJournalPush(file, markdown ?? "", key, value);
		const journalCreated = link?.lastJournalCreated?.trim() ?? "";
		if (link && journalCreated && comparableDateValue(created) !== comparableDateValue(journalCreated)) {
			return { key, value: created };
		}
		const previous = link ? frontmatterComparableValues(link.lastTemplateProperties[key])[0]?.trim() ?? "" : "";
		if (link && previous && comparableDateValue(created) === comparableDateValue(previous)) {
			return null;
		}
		return { key, value: created };
	}

	private createdDateValueForJournalPush(file: TFile, markdown: string, key: string, value: string): string {
		const frontmatterDate = dateOnlyFrontmatterValue(value, this.rawFrontmatterValue(markdown, key));
		if (!frontmatterDate) {
			return value;
		}

		const filenameDate = journalCreatedDateFromNoteName(
			titleForFile(file.path),
			this.settings.journalNoteNameTemplate
		);
		if (!filenameDate?.hasDate || !filenameDate.hasTime || calendarDateString(filenameDate.date) !== frontmatterDate) {
			return value;
		}
		return filenameDate.date.toISOString();
	}

	private bodyForJournalPush(markdown: string, title: string, link?: JournalLink | null): string {
		let body = splitMarkdown(markdown).body;
		if (this.settings.journalIncludeTitleHeading) {
			body = stripGeneratedTitleHeading(body, title);
		}
		if (!link) {
			return journalBodyForPush(body);
		}
		if (link.lastBodySections.some((section) => section.marker)) {
			const content = journalBodyContent(body, link.lastBodySections);
			if (content !== null) {
				return journalBodyForPush(content);
			}
		}
		return journalBodyForPush(stripGeneratedContentChrome(body, link.lastContentPrefix, link.lastContentSuffix));
	}

	private async syncGeneratedAttachmentEdits(file: TFile, link: JournalLink): Promise<void> {
		const photosKey = this.settings.journalPhotosProperty.trim();
		const activeAttachmentKeys = new Set(
			this.settings.journalProperties
				.filter((property) => property.key.trim() && templateUsesAttachments(property.value))
				.map((property) => property.key.trim())
		);
		if (photosKey) {
			activeAttachmentKeys.add(photosKey);
		}
		if (activeAttachmentKeys.size === 0) {
			return;
		}

		const frontmatter = this.frontmatterForFile(file);
		const assetIDs = new Set<string>();
		for (const [propertyKey, previousItems] of Object.entries(link.lastAttachmentPropertyItems)) {
			if (!activeAttachmentKeys.has(propertyKey) || !Object.prototype.hasOwnProperty.call(frontmatter, propertyKey)) {
				continue;
			}
			for (const assetID of removedGeneratedAttachmentIDs(previousItems, frontmatter[propertyKey])) {
				assetIDs.add(assetID);
			}
		}

		const addedFiles = photosKey && Object.prototype.hasOwnProperty.call(frontmatter, photosKey)
			? this.addedPhotoAttachmentFiles(link, frontmatter[photosKey], file.path)
			: [];

		if (assetIDs.size === 0 && addedFiles.length === 0) {
			return;
		}

		for (const assetID of assetIDs) {
			await this.deleteJournalAttachment(link.journalID, assetID, { silent: true });
		}
		for (const added of addedFiles) {
			const result = await this.sendBridgeRequest({
				kind: "journalAddAttachment",
				journalID: link.journalID,
				relativePath: added.path,
			});
			if (!result.ok) {
				this.logSilentError(
					`Markway could not add ${added.path} to Journal`,
					new Error(result.message || "Markway.app rejected the attachment.")
				);
			}
		}

		const entry = await this.getJournalEntry(link.journalID);
		const previousPhotoFiles = addedFiles.length > 0
			? this.mapNewPhotoAttachments(entry, link.lastPhotoFiles, assetIDs, addedFiles)
			: link.lastPhotoFiles;
		const templateState = await this.applyJournalTemplateProperties(file, entry, previousPhotoFiles);
		link.lastTemplateHash = templateState.hash;
		link.lastTemplateSettingsHash = templateState.settingsHash;
		const trackedTemplateState = this.withPushOnlyTemplateProperties(link, templateState);
		link.lastTemplatePropertyKeys = trackedTemplateState.propertyKeys;
		link.lastTemplateProperties = trackedTemplateState.properties;
		link.lastAttachmentPropertyItems = templateState.attachmentPropertyItems;
		link.lastPhotoFiles = templateState.photoFiles;
		link.lastJournalHash = hashJournalContent(entry.title, entry.body);
		link.lastJournalUpdated = entry.updated || link.lastJournalUpdated;
		link.lastSyncedAt = new Date().toISOString();
		await this.savePluginData();
	}

	private addedPhotoAttachmentFiles(link: JournalLink, currentValue: unknown, sourcePath: string): TFile[] {
		const photosKey = this.settings.journalPhotosProperty.trim();
		const previousItems = link.lastAttachmentPropertyItems[photosKey] ?? [];
		const knownPaths = new Set(Object.values(link.lastPhotoFiles));
		const added: TFile[] = [];
		const seen = new Set<string>();

		for (const value of addedFrontmatterValues(previousItems, currentValue)) {
			const file = this.resolveVaultAttachmentFile(value, sourcePath);
			if (!file || knownPaths.has(file.path) || seen.has(file.path)) {
				continue;
			}
			seen.add(file.path);
			added.push(file);
		}
		return added;
	}

	private mapNewPhotoAttachments(
		entry: JournalEntryText,
		previousFiles: Record<string, string>,
		removedAssetIDs: Set<string>,
		addedFiles: TFile[]
	): Record<string, string> {
		const files: Record<string, string> = {};
		for (const [assetID, path] of Object.entries(previousFiles)) {
			if (!removedAssetIDs.has(assetID)) {
				files[assetID] = path;
			}
		}

		const newIDs = (entry.photoAttachments ?? [])
			.map((photo) => photo.id)
			.filter((id) => id && !(id in files));
		// Journal appends new attachments in add order; only map when the counts
		// line up so an unrelated new photo cannot claim the wrong vault file.
		if (newIDs.length === addedFiles.length) {
			newIDs.forEach((id, index) => {
				const added = addedFiles[index];
				if (added) {
					files[id] = added.path;
				}
			});
		}
		return files;
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
		if (existing) {
			return normalizePath(existing.path);
		}

		const renderedName = sanitizeFileName(renderJournalNoteName(entry, this.settings));
		const fileName = `${renderedName || sanitizeFileName(entry.title) || "Journal Entry"}.md`;
		const folder = this.journalImportFolder();
		const desired = folder ? `${folder}/${fileName}` : fileName;
		return normalizePath(desired);
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
		if (this.isObsidianTemplateFile(file)) {
			return;
		}
		const journalID = this.frontmatterJournalIDForFile(file);
		if (!journalID) {
			return;
		}

		const markdown = await this.app.vault.read(file);
		const title = this.journalTitleForFile(file.path);
		this.journalLinks[journalID] = {
			journalID,
			path: file.path,
			title,
			lastSyncedAt: new Date().toISOString(),
			lastJournalCreated: "",
			lastMarkdownHash: sha256Hex(markdown),
			lastJournalHash: hashJournalContent(title, this.bodyForJournalPush(markdown, title)),
			lastJournalUpdated: "",
			lastTemplateHash: "",
			lastTemplateSettingsHash: "",
			lastTemplatePropertyKeys: [],
			lastTemplateProperties: {},
			lastAttachmentPropertyItems: {},
			lastContentPrefix: "",
			lastContentSuffix: "",
			lastBodySections: [],
			lastPhotoFiles: {},
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
		await this.refreshObsidianTemplateFolder();
		for (const file of this.app.vault.getMarkdownFiles()) {
			if (!this.isObsidianTemplateFile(file) && this.frontmatterJournalIDForFile(file)) {
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
			includePhotoAttachments: journalTemplateNeedsPhotos(this.settings),
			includeAttachments: journalTemplateNeedsAttachments(this.settings),
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
		timeoutMs = 60_000,
		requestID?: string
	): Promise<BridgeResponse> {
		return await this.bridge.sendRequest(request, timeoutMs, requestID);
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

	private hasPendingJournalPushForPath(path: string): boolean {
		const normalized = normalizePath(path);
		return Object.values(this.pendingJournalPushes).some((pending) => pending.path === normalized);
	}

	private frontmatterJournalIDForFile(file: TFile): string | null {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const value: unknown = frontmatter?.["markway.appleJournalID"];
		return typeof value === "string" && value.trim() ? value.trim() : null;
	}

	private async refreshObsidianTemplateFolder(): Promise<void> {
		const configPath = normalizePath(`${this.app.vault.configDir}/templates.json`);
		try {
			const exists = await this.app.vault.adapter.exists(configPath);
			if (!exists) {
				this.obsidianTemplateFolder = null;
				return;
			}
			const raw = await this.app.vault.adapter.read(configPath);
			const parsed: unknown = JSON.parse(raw);
			this.obsidianTemplateFolder = obsidianTemplateFolderFromConfig(parsed);
		} catch {
			this.obsidianTemplateFolder = null;
		}
	}

	private isObsidianTemplateFile(file: TFile): boolean {
		return this.isObsidianTemplatePath(file.path);
	}

	private isObsidianTemplatePath(path: string): boolean {
		return isPathInObsidianTemplateFolder(path, this.obsidianTemplateFolder);
	}

	private fileMatchesJournalRules(file: TFile): boolean {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return checkRules(this.app, this.settings.journalRules, file, frontmatter);
	}

	private hasEmptyTemplatedTitle(file: TFile): boolean {
		return journalNoteNameHasEmptyTitle(titleForFile(file.path), this.settings.journalNoteNameTemplate);
	}

	private frontmatterForFile(file: TFile): Record<string, unknown> {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		return isRecord(frontmatter) ? frontmatter : {};
	}

	private frontmatterForMarkdown(markdown: string): Record<string, unknown> {
		const frontmatter = splitMarkdown(markdown).frontmatter;
		if (!frontmatter) {
			return {};
		}
		try {
			const parsed: unknown = parseYaml(frontmatter.replace(/^---\n/, "").replace(/\n---\n?$/, ""));
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	private rawFrontmatterValue(markdown: string, key: string): string | null {
		const frontmatter = splitMarkdown(markdown).frontmatter;
		if (!frontmatter) {
			return null;
		}

		const body = frontmatter.replace(/^---\n/, "").replace(/\n---\n?$/, "");
		const quotedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const keyPattern = `(?:${quotedKey}|["']${quotedKey}["'])`;
		const linePattern = new RegExp(`^\\s*${keyPattern}\\s*:\\s*([^#\\n]*?)\\s*(?:#.*)?$`);
		for (const line of body.split("\n")) {
			const match = line.match(linePattern);
			if (match) {
				return match[1]?.trim() ?? "";
			}
		}
		return null;
	}

	private fileForPath(path: string): TFile | null {
		const abstractFile = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return abstractFile instanceof TFile ? abstractFile : null;
	}

	private cancelQueuedPush(path: string): void {
		const normalized = normalizePath(path);
		const queued = this.syncTimers.get(normalized);
		if (!queued) {
			return;
		}
		window.clearTimeout(queued.timer);
		this.syncTimers.delete(normalized);
	}

	private moveRecentLocalChange(oldPath: string, newPath: string): void {
		const oldNormalized = normalizePath(oldPath);
		const changedAt = this.recentLocalFileChanges.get(oldNormalized);
		if (!changedAt) {
			return;
		}
		this.recentLocalFileChanges.delete(oldNormalized);
		this.recentLocalFileChanges.set(normalizePath(newPath), changedAt);
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

	private async safeAsyncValue(read: () => Promise<string>): Promise<string> {
		try {
			return await read();
		} catch (error) {
			return describeUnknown(error);
		}
	}
}
