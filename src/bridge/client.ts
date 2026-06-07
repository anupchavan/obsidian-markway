import { randomUUID } from "crypto";
import { existsSync, watch } from "fs";
import type { FSWatcher } from "fs";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { sha256Hex, sleep, type JournalEntrySummary, type JournalEntryText } from "../sync-utils";

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
	private watcher: FSWatcher | null = null;
	private drainingEvents = false;

	constructor(
		private readonly vaultPath: () => string,
		private readonly setStatus: (text: string) => void,
		private readonly reportError: (message: string, error: unknown) => void,
		private readonly onRequestStart: () => void,
		private readonly onRequestEnd: () => void
	) { }

	close(): void {
		this.watcher?.close();
		this.watcher = null;
	}

	async registerEventWatcher(onJournalChanged: () => void): Promise<void> {
		try {
			await this.prepareDirectories();
			this.close();
			this.watcher = watch(this.eventsDir(), { persistent: false }, () => {
				void this.drainEvents(onJournalChanged);
			});
			void this.drainEvents(onJournalChanged);
		} catch (error) {
			this.reportError("Markway event watcher failed", error);
		}
	}

	async sendRequest(
		request: Omit<BridgeRequest, "id" | "requestedAt">,
		timeoutMs = 60_000
	): Promise<BridgeResponse> {
		const id = randomUUID().toUpperCase();
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
		return join(this.bridgeBaseDir(), sha256Hex(this.vaultPath()));
	}

	requestsDir(): string {
		return join(this.bridgeRoot(), "requests");
	}

	responsesDir(): string {
		return join(this.bridgeRoot(), "responses");
	}

	eventsDir(): string {
		return join(this.bridgeRoot(), "events");
	}

	private async drainEvents(onJournalChanged: () => void): Promise<void> {
		if (this.drainingEvents) {
			return;
		}

		this.drainingEvents = true;
		try {
			const names = await readdir(this.eventsDir()).catch(() => []);
			let sawJournalChange = false;
			for (const name of names) {
				if (name.endsWith(".json")) {
					sawJournalChange = await this.consumeEvent(name) || sawJournalChange;
				}
			}
			if (sawJournalChange) {
				onJournalChanged();
			}
		} finally {
			this.drainingEvents = false;
		}
	}

	private async consumeEvent(name: string): Promise<boolean> {
		const eventPath = join(this.eventsDir(), name);
		try {
			const event = JSON.parse(await readFile(eventPath, "utf8")) as BridgeEvent;
			return event.kind === "journalChanged";
		} catch (error) {
			console.debug("Could not read Markway bridge event", eventPath, error);
			return false;
		} finally {
			await rm(eventPath, { force: true });
		}
	}

	private async writeRequest(id: string, request: BridgeRequest): Promise<void> {
		const requestPath = join(this.requestsDir(), `${id}.json`);
		const temporaryPath = `${requestPath}.${id}.tmp`;
		await writeFile(temporaryPath, JSON.stringify(request, null, 2), {
			encoding: "utf8",
			mode: 0o600,
		});
		await chmod(temporaryPath, 0o600);
		await rename(temporaryPath, requestPath);
	}

	private async waitForResponse(id: string, timeoutMs: number): Promise<BridgeResponse> {
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

	private async prepareDirectories(): Promise<void> {
		for (const dir of [this.bridgeBaseDir(), this.bridgeRoot(), this.requestsDir(), this.responsesDir(), this.eventsDir()]) {
			await mkdir(dir, { recursive: true, mode: 0o700 });
			await chmod(dir, 0o700);
		}
	}

	private bridgeBaseDir(): string {
		return join(homedir(), "Library", "Application Support", "Markway", "Bridge");
	}
}
