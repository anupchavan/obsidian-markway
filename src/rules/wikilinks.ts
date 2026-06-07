import { App, Notice } from "obsidian";

export function isWikilink(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("[[") && trimmed.endsWith("]]") && trimmed.length > 4;
}

export function extractWikilinkTarget(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("[[") || !trimmed.endsWith("]]")) {
		return text;
	}
	const inner = trimmed.slice(2, -2);
	const pipe = inner.indexOf("|");
	return pipe >= 0 ? inner.slice(0, pipe) : inner;
}

export function extractWikilinkDisplay(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("[[") || !trimmed.endsWith("]]")) {
		return text;
	}
	const inner = trimmed.slice(2, -2);
	const pipe = inner.indexOf("|");
	return pipe >= 0 ? inner.slice(pipe + 1) : inner;
}

export function openWikilinkFile(app: App, linkTarget: string): void {
	const file = app.metadataCache.getFirstLinkpathDest(linkTarget, "");
	if (!file) {
		new Notice(`File not found: ${linkTarget}`);
		return;
	}

	const leaf = app.workspace.getLeaf("tab");
	void leaf.openFile(file).then(() => {
		new Notice(`Opened "${file.basename}"`);
	});
}
