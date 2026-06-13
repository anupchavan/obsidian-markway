import type { DataAdapter } from "obsidian";
import { isRecord, normalizePath, sleep, type JournalEntrySummary, type JournalEntryText } from "../sync-utils";

export interface BridgeRequest {
	id: string;
	kind: "doctor" | "journalList" | "journalGet" | "journalPush" | "journalPull" | "journalDelete" | "journalDeleteAttachment" | "journalExportAttachment" | "journalAddAttachment";
	body?: string;
	relativePath?: string;
	journalID?: string;
	assetID?: string;
	title?: string;
	created?: string;
	includeMusicAttachments?: boolean;
	includePhotoAttachments?: boolean;
	includeAttachments?: boolean;
	stripTitleHeading?: boolean;
	createIfMissing?: boolean;
	requestedAt: string;
}

export interface BridgeResponse {
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

export class MarkwayBridgeClient {
	private eventTimer: number | null = null;
	private drainingEvents = false;

	constructor(
		private readonly adapter: DataAdapter,
		private readonly pluginID: string,
		private readonly setStatus: (text: string) => void,
		private readonly reportError: (message: string, error: unknown) => void,
		private readonly onRequestStart: () => void,
		private readonly onRequestEnd: () => void
	) { }

	close(): void {
		if (this.eventTimer !== null) {
			window.clearInterval(this.eventTimer);
			this.eventTimer = null;
		}
	}

	async registerEventWatcher(onJournalChanged: () => void): Promise<void> {
		try {
			await this.prepareDirectories();
			this.close();
			this.eventTimer = window.setInterval(() => {
				void this.drainEvents(onJournalChanged);
			}, 2_000);
			void this.drainEvents(onJournalChanged);
		} catch (error) {
			this.reportError("Markway event watcher failed", error);
		}
	}

	async sendRequest(
		request: Omit<BridgeRequest, "id" | "requestedAt">,
		timeoutMs = 60_000,
		requestID?: string
	): Promise<BridgeResponse> {
		const id = requestID ?? crypto.randomUUID().toUpperCase();
		const fullRequest: BridgeRequest = {
			id,
			requestedAt: new Date().toISOString(),
			...request,
		};

		this.onRequestStart();
		try {
			await this.prepareDirectories();
			await this.writeRequest(id, fullRequest);
			this.setStatus(`Markway request queued: ${request.kind}`);
			return await this.waitForResponse(id, timeoutMs);
		} finally {
			this.onRequestEnd();
		}
	}

	async listResponseIDs(): Promise<string[]> {
		await this.prepareDirectories();
		return (await this.listFiles(this.responsesDir()))
			.filter((path) => path.endsWith(".json"))
			.map((path) => path.split("/").pop()?.replace(/\.json$/, "") ?? "")
			.filter(Boolean);
	}

	async consumeResponse(id: string): Promise<BridgeResponse | null> {
		await this.prepareDirectories();
		const responsePath = normalizePath(`${this.responsesDir()}/${id}.json`);
		if (!(await this.adapter.exists(responsePath))) {
			return null;
		}
		const text = await this.adapter.read(responsePath);
		await this.removeIfExists(responsePath);
		return this.parseBridgeResponse(text, id);
	}

	bridgeRoot(): string {
		return this.bridgeBaseDir();
	}

	requestsDir(): string {
		return normalizePath(`${this.bridgeRoot()}/requests`);
	}

	responsesDir(): string {
		return normalizePath(`${this.bridgeRoot()}/responses`);
	}

	eventsDir(): string {
		return normalizePath(`${this.bridgeRoot()}/events`);
	}

	async requestsExist(): Promise<boolean> {
		return await this.adapter.exists(this.requestsDir());
	}

	private async drainEvents(onJournalChanged: () => void): Promise<void> {
		if (this.drainingEvents) {
			return;
		}

		this.drainingEvents = true;
		try {
			const files = await this.listFiles(this.eventsDir());
			let sawJournalChange = false;
			for (const path of files) {
				if (path.endsWith(".json")) {
					sawJournalChange = await this.consumeEvent(path) || sawJournalChange;
				}
			}
			if (sawJournalChange) {
				onJournalChanged();
			}
		} finally {
			this.drainingEvents = false;
		}
	}

	private async consumeEvent(eventPath: string): Promise<boolean> {
		try {
			const event = this.parseBridgeEvent(await this.adapter.read(eventPath));
			return event.kind === "journalChanged";
		} catch (error) {
			console.debug("Could not read Markway bridge event", eventPath, error);
			return false;
		} finally {
			await this.removeIfExists(eventPath);
		}
	}

	private async writeRequest(id: string, request: BridgeRequest): Promise<void> {
		const requestPath = normalizePath(`${this.requestsDir()}/${id}.json`);
		const temporaryPath = `${requestPath}.${id}.tmp`;
		await this.adapter.write(temporaryPath, JSON.stringify(request, null, 2));
		await this.adapter.rename(temporaryPath, requestPath);
	}

	private async waitForResponse(id: string, timeoutMs: number): Promise<BridgeResponse> {
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			const response = await this.consumeResponse(id);
			if (response) {
				return response;
			}
			await sleep(350);
		}

		throw new Error(
			"Timed out waiting for Markway.app. Open Markway, set this vault path, and start the bridge."
		);
	}

	private async prepareDirectories(): Promise<void> {
		for (const dir of [this.pluginDataDir(), this.bridgeRoot(), this.requestsDir(), this.responsesDir(), this.eventsDir()]) {
			await this.ensureDirectory(dir);
		}
	}

	private bridgeBaseDir(): string {
		return normalizePath(`${this.pluginDataDir()}/bridge`);
	}

	private pluginDataDir(): string {
		return normalizePath(`.obsidian/plugins/${this.pluginID}`);
	}

	private async ensureDirectory(path: string): Promise<void> {
		if (await this.adapter.exists(path)) {
			return;
		}

		try {
			await this.adapter.mkdir(path);
		} catch (error) {
			if (!(await this.adapter.exists(path))) {
				throw error;
			}
		}
	}

	private async listFiles(path: string): Promise<string[]> {
		try {
			return (await this.adapter.list(path)).files;
		} catch {
			return [];
		}
	}

	private async removeIfExists(path: string): Promise<void> {
		if (await this.adapter.exists(path)) {
			await this.adapter.remove(path);
		}
	}

	private parseBridgeEvent(text: string): BridgeEvent {
		const value = JSON.parse(text) as Partial<BridgeEvent>;
		if (value.kind !== "journalChanged") {
			throw new Error("Unknown Markway bridge event");
		}

		return {
			id: typeof value.id === "string" ? value.id : "",
			kind: value.kind,
			createdAt: typeof value.createdAt === "string" ? value.createdAt : "",
		};
	}

	private parseBridgeResponse(text: string, expectedID: string): BridgeResponse {
		const value: unknown = JSON.parse(text);
		if (!isRecord(value)) {
			throw new Error("Invalid Markway bridge response");
		}
		if (value.id !== expectedID) {
			throw new Error("Mismatched Markway bridge response");
		}
		if (typeof value.ok !== "boolean") {
			throw new Error("Invalid Markway bridge response");
		}

		return {
			id: value.id,
			ok: value.ok,
			message: typeof value.message === "string" ? value.message : "",
			journalID: typeof value.journalID === "string" ? value.journalID : undefined,
			entry: isRecord(value.entry) ? value.entry as unknown as JournalEntryText : undefined,
			entries: Array.isArray(value.entries) ? value.entries as JournalEntrySummary[] : undefined,
			completedAt: typeof value.completedAt === "string" ? value.completedAt : "",
		};
	}
}
