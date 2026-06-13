import type { DataAdapter } from "obsidian";
import { describe, expect, it } from "vitest";
import { MarkwayBridgeClient, type BridgeRequest, type BridgeResponse } from "../src/bridge-client";

class MemoryAdapter {
	files = new Map<string, string>();
	directories = new Set<string>();

	constructor(private readonly onRequest?: (request: BridgeRequest, adapter: MemoryAdapter) => void) { }

	async exists(path: string): Promise<boolean> {
		return this.files.has(path) || this.directories.has(path);
	}

	async mkdir(path: string): Promise<void> {
		this.directories.add(path);
	}

	async write(path: string, data: string): Promise<void> {
		this.files.set(path, data);
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const data = this.files.get(oldPath);
		if (data === undefined) {
			throw new Error(`Missing file: ${oldPath}`);
		}
		this.files.delete(oldPath);
		this.files.set(newPath, data);
		if (newPath.endsWith("/requests/" + this.requestIDFromPath(newPath) + ".json")) {
			this.onRequest?.(JSON.parse(data) as BridgeRequest, this);
		}
	}

	async read(path: string): Promise<string> {
		const data = this.files.get(path);
		if (data === undefined) {
			throw new Error(`Missing file: ${path}`);
		}
		return data;
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
		this.directories.delete(path);
	}

	async list(path: string): Promise<{ files: string[]; folders: string[] }> {
		const prefix = `${path}/`;
		return {
			files: [...this.files.keys()].filter((item) => item.startsWith(prefix)),
			folders: [...this.directories].filter((item) => item.startsWith(prefix)),
		};
	}

	private requestIDFromPath(path: string): string {
		return path.split("/").pop()?.replace(/\.json$/, "") ?? "";
	}
}

function clientWith(adapter: MemoryAdapter, counters = { started: 0, ended: 0 }): MarkwayBridgeClient {
	return new MarkwayBridgeClient(
		adapter as unknown as DataAdapter,
		"markway",
		() => undefined,
		() => undefined,
		() => {
			counters.started += 1;
		},
		() => {
			counters.ended += 1;
		}
	);
}

function writeResponse(adapter: MemoryAdapter, response: BridgeResponse): void {
	adapter.files.set(
		`.obsidian/plugins/markway/bridge/responses/${response.id}.json`,
		JSON.stringify(response)
	);
}

describe("MarkwayBridgeClient", () => {
	it("accepts a response whose id matches the queued request", async () => {
		const adapter = new MemoryAdapter((request, store) => {
			writeResponse(store, {
				id: request.id,
				ok: true,
				message: "ok",
				completedAt: "2026-06-13T00:00:00Z",
			});
		});
		const counters = { started: 0, ended: 0 };
		const client = clientWith(adapter, counters);

		const response = await client.sendRequest({ kind: "doctor" }, 10);

		expect(response.ok).toBe(true);
		expect(response.message).toBe("ok");
		expect(counters).toEqual({ started: 1, ended: 1 });
		expect([...adapter.files.keys()].some((path) => path.includes("/responses/"))).toBe(false);
	});

	it("rejects a response file whose JSON id does not match the request", async () => {
		const adapter = new MemoryAdapter((request, store) => {
			store.files.set(
				`.obsidian/plugins/markway/bridge/responses/${request.id}.json`,
				JSON.stringify({
					id: "OTHER-ID",
					ok: true,
					message: "wrong",
					completedAt: "2026-06-13T00:00:00Z",
				})
			);
		});
		const counters = { started: 0, ended: 0 };
		const client = clientWith(adapter, counters);

		await expect(client.sendRequest({ kind: "doctor" }, 10)).rejects.toThrow("Mismatched Markway bridge response");

		expect(counters).toEqual({ started: 1, ended: 1 });
		expect([...adapter.files.keys()].some((path) => path.includes("/responses/"))).toBe(false);
	});
});
