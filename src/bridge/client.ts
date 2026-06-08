import type { DataAdapter } from "obsidian";
import { normalizePath, sleep, type JournalEntrySummary, type JournalEntryText } from "../sync-utils";

export interface BridgeRequest {
	id: string;
	kind: "doctor" | "journalList" | "journalGet" | "journalPush" | "journalPull" | "journalDelete" | "journalDeleteAttachment";
	relativePath?: string;
	journalID?: string;
	assetID?: string;
	title?: string;
	includeMusicAttachments?: boolean;
	stripTitleHeading?: boolean;
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
		timeoutMs = 60_000
	): Promise<BridgeResponse> {
		const id = crypto.randomUUID().toUpperCase();
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
		const responsePath = normalizePath(`${this.responsesDir()}/${id}.json`);
		const started = Date.now();
		while (Date.now() - started < timeoutMs) {
			if (await this.adapter.exists(responsePath)) {
				const text = await this.adapter.read(responsePath);
				await this.removeIfExists(responsePath);
				return JSON.parse(text) as BridgeResponse;
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
}
