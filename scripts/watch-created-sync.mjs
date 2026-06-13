#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(scriptDir, "..");
const defaultVault = path.resolve(pluginDir, "..", "..", "..");
const vault = path.resolve(args.vault ?? defaultVault);
const intervalMs = Number.parseInt(args.interval ?? "250", 10);
const once = args.once === true;
const includeExistingBridge = args["include-existing-bridge"] === true;
const explicitCreatedKey = typeof args["created-key"] === "string" ? args["created-key"].trim() : "";

const pluginIDs = ["markway", "obsidian-markway"];
const pluginDataFiles = uniquePaths([
	...pluginIDs.map((id) => path.join(vault, ".obsidian", "plugins", id, "data.json")),
	path.join(pluginDir, "data.json"),
]);
const bridgeDirs = uniquePaths(pluginIDs.map((id) => path.join(vault, ".obsidian", "plugins", id, "bridge")));
const logPath = path.join(
	pluginDir,
	`created-sync-watch-${new Date().toISOString().replace(/[:.]/g, "-")}.log`
);
const logStream = fs.createWriteStream(logPath, { flags: "a" });

let previousNotes = new Map();
let previousLinks = new Map();
let previousSettings = new Map();
let previousBridgeFiles = new Map();
let initializedBridge = false;
let loopRunning = false;

log(`watching vault root: ${vault}`);
log(`plugin data candidates: ${pluginDataFiles.join(", ")}`);
log(`bridge candidates: ${bridgeDirs.join(", ")}`);
log(`log file: ${logPath}`);
log("paste/copy markdown files into the vault root now; press Ctrl-C to stop.");

process.on("SIGINT", () => {
	log("stopped");
	logStream.end();
	process.exit(0);
});

await tick({ baseline: true });
if (once) {
	logStream.end();
	process.exit(0);
}

startBridgeWatchers();

setInterval(() => {
	if (loopRunning) {
		return;
	}
	loopRunning = true;
	tick({ baseline: false })
		.catch((error) => log(`watch error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`))
		.finally(() => {
			loopRunning = false;
		});
}, Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 250);

function startBridgeWatchers() {
	for (const bridgeDir of bridgeDirs) {
		for (const bucket of ["requests", "responses", "events"]) {
			const dir = path.join(bridgeDir, bucket);
			if (!fs.existsSync(dir)) {
				continue;
			}
			try {
				fs.watch(dir, { persistent: true }, (_eventType, fileName) => {
					if (!fileName || !String(fileName).endsWith(".json")) {
						return;
					}
					const name = String(fileName);
					const filePath = path.join(dir, name);
					setTimeout(() => {
						void readAndReportBridgeFile(pluginLabel(bridgeDir), bucket, filePath, name);
					}, 5);
					setTimeout(() => {
						void readAndReportBridgeFile(pluginLabel(bridgeDir), bucket, filePath, name);
					}, 50);
				});
			} catch (error) {
				log(`[bridge:${pluginLabel(bridgeDir)}:${bucket}] fs.watch unavailable: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}

async function tick({ baseline }) {
	const pluginStates = await readPluginStates();
	const createdKeys = createdKeyCandidates(pluginStates);
	reportSettings(pluginStates, baseline);

	const notes = await readRootNotes(createdKeys, pluginStates);
	reportNotes(notes, baseline);
	reportLinks(pluginStates, notes, createdKeys, baseline);
	await reportBridgeFiles(baseline);
}

function parseArgs(argv) {
	const parsed = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) {
			continue;
		}
		const name = arg.slice(2);
		const next = argv[index + 1];
		if (!next || next.startsWith("--")) {
			parsed[name] = true;
		} else {
			parsed[name] = next;
			index += 1;
		}
	}
	return parsed;
}

async function readPluginStates() {
	const states = [];
	for (const filePath of pluginDataFiles) {
		const json = await readJSON(filePath);
		if (!json) {
			continue;
		}
		const stat = await statOrNull(filePath);
		const settings = isRecord(json.settings) ? json.settings : json;
		const links = isRecord(json.journalLinks) ? json.journalLinks : {};
		states.push({
			filePath,
			label: pluginLabel(filePath),
			mtimeMs: stat?.mtimeMs ?? 0,
			settings,
			links,
		});
	}
	states.sort((left, right) => right.mtimeMs - left.mtimeMs);
	return states;
}

function createdKeyCandidates(pluginStates) {
	if (explicitCreatedKey) {
		return [explicitCreatedKey];
	}
	const keys = [];
	for (const state of pluginStates) {
		const key = typeof state.settings.journalCreatedProperty === "string"
			? state.settings.journalCreatedProperty.trim()
			: "";
		if (key && !keys.includes(key)) {
			keys.push(key);
		}
	}
	for (const fallback of ["created", "created_at", "date", "createdDate", "creationDate"]) {
		if (!keys.includes(fallback)) {
			keys.push(fallback);
		}
	}
	return keys;
}

function reportSettings(pluginStates, baseline) {
	for (const state of pluginStates) {
		const key = state.filePath;
		const snapshot = JSON.stringify({
			created: state.settings.journalCreatedProperty ?? "",
			photos: state.settings.journalPhotosProperty ?? "",
			rules: state.settings.journalRules ?? null,
			linkCount: Object.keys(state.links).length,
		});
		if (baseline || previousSettings.get(key) !== snapshot) {
			log(`[settings:${state.label}] createdProperty=${quote(state.settings.journalCreatedProperty)} photosProperty=${quote(state.settings.journalPhotosProperty)} links=${Object.keys(state.links).length}`);
			previousSettings.set(key, snapshot);
		}
	}
	if (baseline && pluginStates.length === 0) {
		log("[settings] no plugin data files found");
	}
}

async function readRootNotes(createdKeys, pluginStates) {
	const names = await fsp.readdir(vault).catch(() => []);
	const notes = new Map();
	for (const name of names) {
		if (!name.toLowerCase().endsWith(".md")) {
			continue;
		}
		const absolutePath = path.join(vault, name);
		const stat = await statOrNull(absolutePath);
		if (!stat?.isFile()) {
			continue;
		}
		const markdown = await fsp.readFile(absolutePath, "utf8").catch(() => "");
		const frontmatter = parseFrontmatter(markdown);
		const dateKeys = Object.keys(frontmatter).filter((key) => /created|date/i.test(key));
		const keys = uniqueValues([...createdKeys, ...dateKeys]);
		const values = {};
		for (const key of keys) {
			if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
				values[key] = String(frontmatter[key]);
			}
		}
		const relativePath = name;
		notes.set(relativePath, {
			relativePath,
			absolutePath,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
			hash: sha256(markdown),
			values,
			frontmatterJournalID: frontmatter["markway.appleJournalID"] ?? "",
			links: linksForPath(pluginStates, relativePath),
		});
	}
	return notes;
}

function reportNotes(notes, baseline) {
	for (const [relativePath, note] of notes) {
		const snapshot = JSON.stringify({
			size: note.size,
			mtimeMs: Math.round(note.mtimeMs),
			hash: note.hash,
			values: note.values,
			frontmatterJournalID: note.frontmatterJournalID,
			links: note.links.map((link) => link.summary),
		});
		const previous = previousNotes.get(relativePath);
		if (baseline || previous !== snapshot) {
			const prefix = previous ? "changed" : "seen";
			log(`[note:${prefix}] ${relativePath} dates=${formatObject(note.values)} fmJournalID=${quote(note.frontmatterJournalID)} links=${formatLinks(note.links)}`);
			if (previous && previous !== snapshot) {
				const old = JSON.parse(previous);
				for (const key of uniqueValues([...Object.keys(old.values ?? {}), ...Object.keys(note.values)])) {
					if ((old.values ?? {})[key] !== note.values[key]) {
						log(`  [note:date-change] ${relativePath} ${key}: ${quote((old.values ?? {})[key])} -> ${quote(note.values[key])}`);
					}
				}
			}
			previousNotes.set(relativePath, snapshot);
		}
	}
	for (const relativePath of [...previousNotes.keys()]) {
		if (!notes.has(relativePath)) {
			log(`[note:removed] ${relativePath}`);
			previousNotes.delete(relativePath);
		}
	}
}

function reportLinks(pluginStates, notes, createdKeys, baseline) {
	const interestingPaths = new Set(notes.keys());
	for (const state of pluginStates) {
		for (const link of Object.values(state.links)) {
			if (!isRecord(link) || typeof link.path !== "string") {
				continue;
			}
			if (path.dirname(link.path) === "." || interestingPaths.has(link.path)) {
				const key = `${state.label}:${link.journalID ?? ""}:${link.path}`;
				const createdValues = {};
				const lastProps = isRecord(link.lastTemplateProperties) ? link.lastTemplateProperties : {};
				for (const createdKey of createdKeys) {
					if (Object.prototype.hasOwnProperty.call(lastProps, createdKey)) {
						createdValues[createdKey] = String(lastProps[createdKey]);
					}
				}
				const snapshot = JSON.stringify({
					path: link.path,
					title: link.title,
					lastSyncedAt: link.lastSyncedAt,
					lastJournalUpdated: link.lastJournalUpdated,
					createdValues,
				});
				if (baseline || previousLinks.get(key) !== snapshot) {
					log(`[link:${state.label}] ${link.path} id=${quote(link.journalID)} title=${quote(link.title)} lastTemplateCreated=${formatObject(createdValues)} lastSyncedAt=${quote(link.lastSyncedAt)} journalUpdated=${quote(link.lastJournalUpdated)}`);
					previousLinks.set(key, snapshot);
				}
			}
		}
	}
}

async function reportBridgeFiles(baseline) {
	for (const bridgeDir of bridgeDirs) {
		for (const bucket of ["requests", "responses", "events"]) {
			const dir = path.join(bridgeDir, bucket);
			const files = await fsp.readdir(dir).catch(() => []);
			for (const fileName of files) {
				if (!fileName.endsWith(".json")) {
					continue;
				}
				const filePath = path.join(dir, fileName);
				const stat = await statOrNull(filePath);
				if (!stat?.isFile()) {
					continue;
				}
				const seen = previousBridgeFiles.get(filePath);
				const stamp = `${Math.round(stat.mtimeMs)}:${stat.size}`;
				if (!initializedBridge && !includeExistingBridge) {
					previousBridgeFiles.set(filePath, stamp);
					continue;
				}
				if (!baseline && seen === stamp) {
					continue;
				}
				previousBridgeFiles.set(filePath, stamp);
				await readAndReportBridgeFile(pluginLabel(bridgeDir), bucket, filePath, fileName);
			}
		}
	}
	initializedBridge = true;
}

async function readAndReportBridgeFile(label, bucket, filePath, fileName) {
	const stat = await statOrNull(filePath);
	if (!stat?.isFile()) {
		return;
	}
	previousBridgeFiles.set(filePath, `${Math.round(stat.mtimeMs)}:${stat.size}`);
	const value = await readJSON(filePath);
	reportBridgeJSON(label, bucket, fileName, value);
}

function reportBridgeJSON(label, bucket, fileName, value) {
	if (!isRecord(value)) {
		log(`[bridge:${label}:${bucket}] ${fileName} unreadable`);
		return;
	}
	if (bucket === "requests") {
		if (value.kind === "journalPush") {
			log(`[bridge:${label}:request] journalPush path=${quote(value.relativePath)} journalID=${quote(value.journalID)} title=${quote(value.title)} created=${quote(value.created)} id=${quote(value.id)}`);
		} else {
			log(`[bridge:${label}:request] ${quote(value.kind)} path=${quote(value.relativePath)} journalID=${quote(value.journalID)} id=${quote(value.id)}`);
		}
		return;
	}
	if (bucket === "responses") {
		const entry = isRecord(value.entry) ? value.entry : null;
		log(`[bridge:${label}:response] ok=${value.ok === true} message=${quote(value.message)} journalID=${quote(value.journalID)} entryCreated=${quote(entry?.created)} id=${quote(value.id)}`);
		return;
	}
	log(`[bridge:${label}:event] kind=${quote(value.kind)} createdAt=${quote(value.createdAt)} id=${quote(value.id)}`);
}

function linksForPath(pluginStates, relativePath) {
	const links = [];
	for (const state of pluginStates) {
		for (const link of Object.values(state.links)) {
			if (!isRecord(link) || link.path !== relativePath) {
				continue;
			}
			links.push({
				label: state.label,
				summary: {
					id: link.journalID ?? "",
					title: link.title ?? "",
					lastSyncedAt: link.lastSyncedAt ?? "",
					lastJournalUpdated: link.lastJournalUpdated ?? "",
				},
			});
		}
	}
	return links;
}

function parseFrontmatter(markdown) {
	const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return {};
	}
	const closeMatch = /\n---(?:\n|$)/.exec(normalized.slice(4));
	if (!closeMatch || closeMatch.index === undefined) {
		return {};
	}
	const close = closeMatch.index + 4;
	const body = normalized.slice(4, close);
	const result = {};
	for (const line of body.split("\n")) {
		if (!line.trim() || /^\s/.test(line) || line.trimStart().startsWith("#")) {
			continue;
		}
		const match = line.match(/^([^:]+):(?:\s*(.*))?$/);
		if (!match) {
			continue;
		}
		const key = (match[1] ?? "").trim();
		if (!key) {
			continue;
		}
		result[key] = cleanYamlScalar(match[2] ?? "");
	}
	return result;
}

function cleanYamlScalar(value) {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"'))
		|| (trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed.replace(/\s+#.*$/, "");
}

async function readJSON(filePath) {
	try {
		return JSON.parse(await fsp.readFile(filePath, "utf8"));
	} catch {
		return null;
	}
}

async function statOrNull(filePath) {
	try {
		return await fsp.stat(filePath);
	} catch {
		return null;
	}
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniquePaths(paths) {
	return [...new Set(paths.map((item) => path.resolve(item)))];
}

function uniqueValues(values) {
	return [...new Set(values.filter((value) => value !== "" && value !== undefined && value !== null))];
}

function pluginLabel(filePath) {
	const marker = `${path.sep}.obsidian${path.sep}plugins${path.sep}`;
	const index = filePath.indexOf(marker);
	if (index === -1) {
		return path.basename(path.dirname(filePath));
	}
	return filePath.slice(index + marker.length).split(path.sep)[0] ?? "plugin";
}

function sha256(text) {
	return crypto.createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function formatObject(value) {
	const entries = Object.entries(value ?? {});
	if (entries.length === 0) {
		return "{}";
	}
	return `{ ${entries.map(([key, val]) => `${key}: ${quote(val)}`).join(", ")} }`;
}

function formatLinks(links) {
	if (!links.length) {
		return "[]";
	}
	return `[${links.map((link) => `${link.label}:${link.summary.id || "?"}`).join(", ")}]`;
}

function quote(value) {
	if (value === undefined || value === null || value === "") {
		return "(empty)";
	}
	return JSON.stringify(String(value));
}

function log(message) {
	const line = `${new Date().toISOString()} ${message}`;
	console.log(line);
	logStream.write(`${line}\n`);
}
