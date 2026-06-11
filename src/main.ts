import { randomUUID } from "crypto";
import { basename, dirname, extname } from "path";
import {
	FileSystemAdapter,
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
} from "obsidian";
import { checkRules, firstFolderFromRules } from "./rules";
import { extractWikilinkTarget } from "./rules/wikilinks";
import { MarkwayBridgeClient, type BridgeRequest, type BridgeResponse } from "./bridge-client";
import { registerMarkwayCommands } from "./commands";
import {
	journalBodyContent,
	journalTemplateNeedsAttachments,
	journalTemplateNeedsMusic,
	journalTemplateNeedsPhotos,
	journalTemplateSettingsHash,
	parseJournalBodySections,
	renderJournalBodySections,
	renderJournalTemplateProperties,
	serializeJournalBody,
	stripGeneratedContentChrome,
	stripGeneratedTitleHeading,
	templateUsesAttachments,
} from "./journal-template";

import { MarkwaySettingTab } from "./settings";
import {
	addedFrontmatterValues,
	canonicalPath,
	composeMarkdown,
	describeUnknown,
	explainMarkwayError,
	frontmatterComparableValues,
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
	removedGeneratedAttachmentIDs,
	sameVaultPath,
	sanitizeFileName,
	sha256Hex,
	sleep,
	splitMarkdown,
	titleForFile,
	vaultPathKey,
	type GeneratedAttachmentPropertyItem,
	type JournalBodySection,
	type JournalEntrySummary,
	type JournalEntryText,
	type JournalLink,
	type JournalPhotoAttachment,
	type MarkwayPluginData,
	type MarkwaySettings,
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

export default class MarkwayPlugin extends Plugin {
	settings!: MarkwaySettings;
	journalLinks: Record<string, JournalLink> = {};
	private statusEl!: HTMLElement;
	private bridge!: MarkwayBridgeClient;
	private bridgeRequestsInFlight = 0;
	private journalSyncInProgress = false;
	private queuedJournalSync: SyncOptions | null = null;
	private journalSyncTimer: number | null = null;
	private templateRefreshTimer: number | null = null;
	private syncTimers = new Map<string, number>();
	private suppressedFilePaths = new Map<string, number>();
	private recentLocalFileChanges = new Map<string, number>();

	async onload() {
		await this.loadPluginData();

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
			window.clearTimeout(timer);
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
			window.clearTimeout(this.journalSyncTimer);
		}

		const delay = Math.max(1200, this.settings.debounceMs);
		this.journalSyncTimer = window.setTimeout(() => {
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
			window.clearTimeout(this.templateRefreshTimer);
		}

		this.templateRefreshTimer = window.setTimeout(() => {
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
			window.clearTimeout(existingTimer);
		}

		const timer = window.setTimeout(() => {
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
		this.bridgeRequestsInFlight += 1;
		try {
			await this.migrateFrontmatterLink(file);
			const link = this.linkForFile(file);
			if (options.linkedOnly && !link) {
				return;
			}
			if (link) {
				await this.syncGeneratedAttachmentEdits(file, link);
			}

			const title = titleForFile(file.path);
			const markdown = await this.app.vault.read(file);
			const journalBody = this.bodyForJournalPush(markdown, title, link);
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
				// Send the extracted journal text; Markway.app must not push the
				// raw file, which contains generated template sections.
				body: journalBody,
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
				lastAttachmentPropertyItems: link?.lastAttachmentPropertyItems ?? {},
				lastContentPrefix: link?.lastContentPrefix ?? "",
				lastContentSuffix: link?.lastContentSuffix ?? "",
				lastBodySections: link?.lastBodySections ?? [],
				lastPhotoFiles: link?.lastPhotoFiles ?? {},
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
			properties[photosKey] = photoSync.values;
			if (photoSync.items.length > 0) {
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
		if (!file) {
			return false;
		}

		if (this.syncTimers.has(file.path) || this.isRecentlyLocallyChanged(file.path)) {
			return true;
		}

		const markdown = await this.app.vault.read(file);
		const title = titleForFile(file.path);
		return hasUnsyncedMarkdownContent(link, markdown, title, this.bodyForJournalPush(markdown, title, link));
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

	private bodyForJournalPush(markdown: string, title: string, link?: JournalLink | null): string {
		let body = splitMarkdown(markdown).body;
		if (this.settings.journalIncludeTitleHeading) {
			body = stripGeneratedTitleHeading(body, title);
		}
		if (!link) {
			return body;
		}
		if (link.lastBodySections.some((section) => section.marker)) {
			const content = journalBodyContent(body, link.lastBodySections);
			if (content !== null) {
				return content;
			}
		}
		return stripGeneratedContentChrome(body, link.lastContentPrefix, link.lastContentSuffix);
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
		link.lastTemplatePropertyKeys = templateState.propertyKeys;
		link.lastTemplateProperties = templateState.properties;
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
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
		const value: unknown = frontmatter?.["markway.appleJournalID"];
		return typeof value === "string" && value.trim() ? value.trim() : null;
	}

	private fileMatchesJournalRules(file: TFile): boolean {
		const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
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

	private async safeAsyncValue(read: () => Promise<string>): Promise<string> {
		try {
			return await read();
		} catch (error) {
			return describeUnknown(error);
		}
	}
}
