import type { MarkdownParts } from "./types";
import { sha256Hex } from "./primitives";

export function splitMarkdown(markdown: string): MarkdownParts {
	const normalized = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	if (!normalized.startsWith("---\n")) {
		return { frontmatter: null, body: normalized };
	}
	const close = normalized.indexOf("\n---\n", 4);
	if (close === -1) {
		return { frontmatter: null, body: normalized };
	}
	return {
		frontmatter: normalized.slice(0, close + 5),
		body: normalized.slice(close + 5),
	};
}

export function composeMarkdown(frontmatter: string | null, body: string): string {
	return frontmatter ? `${frontmatter}${body}` : body;
}

export function preserveMarkdownStructure(existingBody: string, journalBody: string): string {
	const existing = normalizeLineEndings(existingBody).split("\n");
	const journal = normalizeLineEndings(journalBody).split("\n");
	if (!existingBody.trim()) {
		return journalBody;
	}

	const output: string[] = [];
	let journalIndex = 0;
	let existingIndex = 0;

	while (existingIndex < existing.length) {
		const existingLine = existing[existingIndex] ?? "";

		if (isBlank(existingLine)) {
			if (journalIndex < journal.length && isBlank(journal[journalIndex] ?? "")) {
				output.push(journal[journalIndex] ?? "");
				journalIndex += 1;
			} else {
				output.push(existingLine);
			}
			existingIndex += 1;
			continue;
		}

		if (isFenceStart(existingLine)) {
			const codeBlock = collectFencedBlock(existing, existingIndex);
			const journalCode = takeJournalCodeBlock(journal, journalIndex, codeBlock.content.length);
			output.push(codeBlock.opening);
			output.push(...journalCode.lines);
			output.push(codeBlock.closing);
			journalIndex = journalCode.nextIndex;
			existingIndex = codeBlock.nextIndex;
			continue;
		}

		const journalLine = takeJournalContentLine(journal, journalIndex);
		const current = journalLine.line ?? existingLine;
		journalIndex = journalLine.nextIndex;

		const heading = existingLine.match(/^(\s{0,3})(#{1,6})\s+(.*)$/);
		if (heading) {
			output.push(`${heading[1] ?? ""}${heading[2] ?? "#"} ${markdownLineText(current)}`);
			existingIndex += 1;
			continue;
		}

		const quote = existingLine.match(/^(\s{0,3}>\s?)(.*)$/);
		if (quote) {
			output.push(`${quote[1] ?? "> "}${markdownLineText(current)}`);
			existingIndex += 1;
			continue;
		}

		if (isThematicBreak(existingLine)) {
			journalIndex = isThematicBreak(current) ? journalLine.nextIndex : journalLine.startIndex;
			output.push(existingLine);
			existingIndex += 1;
			continue;
		}

		const list = existingLine.match(/^(\s*)((?:[-*+])|(?:\d+[.)]))\s+(.*)$/);
		if (list && !current.match(/^(\s*)((?:[-*+])|(?:\d+[.)]))\s+/)) {
			output.push(`${list[1] ?? ""}${list[2] ?? "-"} ${markdownLineText(current)}`);
			existingIndex += 1;
			continue;
		}

		output.push(current);
		existingIndex += 1;
	}

	if (journalIndex < journal.length) {
		output.push(...journal.slice(journalIndex));
	}

	return alignTrailingBlankLines(output, journal).join("\n");
}

export function hashJournalContent(title: string, body: string): string {
	return sha256Hex(`${title}\0${body}`);
}

function normalizeLineEndings(value: string): string {
	return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function isBlank(line: string): boolean {
	return line.trim() === "";
}

function isFenceStart(line: string): boolean {
	return /^ {0,3}(`{3,}|~{3,})/.test(line);
}

function isFenceClose(line: string, opener: string): boolean {
	const marker = opener.trimStart().startsWith("~") ? "~" : "`";
	const length = opener.trimStart().match(/^(`{3,}|~{3,})/)?.[0]?.length ?? 3;
	return new RegExp(`^ {0,3}${escapeRegExp(marker.repeat(length))}\\s*$`).test(line);
}

function collectFencedBlock(
	lines: string[],
	start: number
): { opening: string; closing: string; content: string[]; nextIndex: number } {
	const opening = lines[start] ?? "```";
	const content: string[] = [];
	let index = start + 1;
	while (index < lines.length) {
		const line = lines[index] ?? "";
		if (isFenceClose(line, opening)) {
			return { opening, closing: line, content, nextIndex: index + 1 };
		}
		content.push(line);
		index += 1;
	}
	return { opening, closing: opening.trimStart().startsWith("~") ? "~~~" : "```", content, nextIndex: index };
}

function takeJournalCodeBlock(lines: string[], start: number, fallbackLength: number): { lines: string[]; nextIndex: number } {
	let index = skipBlankLines(lines, start);
	const opener = lines[index] ?? "";
	if (isFenceStart(opener)) {
		const block = collectFencedBlock(lines, index);
		return { lines: block.content, nextIndex: block.nextIndex };
	}

	const content: string[] = [];
	const length = Math.max(1, fallbackLength);
	while (index < lines.length && content.length < length) {
		const line = lines[index] ?? "";
		if (isBlank(line) && content.length > 0) {
			break;
		}
		content.push(line);
		index += 1;
	}
	return { lines: content, nextIndex: index };
}

function takeJournalContentLine(lines: string[], start: number): { line: string | null; startIndex: number; nextIndex: number } {
	const contentIndex = skipBlankLines(lines, start);
	if (contentIndex >= lines.length) {
		return { line: null, startIndex: start, nextIndex: contentIndex };
	}
	return { line: lines[contentIndex] ?? "", startIndex: contentIndex, nextIndex: contentIndex + 1 };
}

function skipBlankLines(lines: string[], start: number): number {
	let index = start;
	while (index < lines.length && isBlank(lines[index] ?? "")) {
		index += 1;
	}
	return index;
}

function alignTrailingBlankLines(output: string[], journal: string[]): string[] {
	const desiredTrailingBlanks = trailingBlankLineCount(journal);
	const currentTrailingBlanks = trailingBlankLineCount(output);
	if (currentTrailingBlanks === desiredTrailingBlanks) {
		return output;
	}
	return [...output.slice(0, output.length - currentTrailingBlanks), ...Array.from({ length: desiredTrailingBlanks }, () => "")];
}

function trailingBlankLineCount(lines: string[]): number {
	let count = 0;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (!isBlank(lines[index] ?? "")) {
			break;
		}
		count += 1;
	}
	return count;
}

function markdownLineText(line: string): string {
	let text = line.trim();
	const heading = text.match(/^#{1,6}\s+(.*)$/);
	if (heading) {
		text = heading[1] ?? "";
	}
	const quote = text.match(/^>\s?(.*)$/);
	if (quote) {
		text = quote[1] ?? "";
	}
	const list = text.match(/^((?:[-*+])|(?:\d+[.)]))\s+(.*)$/);
	if (list) {
		text = list[2] ?? "";
	}
	for (let changed = true; changed;) {
		changed = false;
		for (const wrapper of markdownWrappers) {
			const match = text.match(wrapper);
			if (match) {
				text = match[1] ?? "";
				changed = true;
			}
		}
	}
	return text;
}

const markdownWrappers = [
	/^\*\*\*(.*)\*\*\*$/,
	/^___(.*)___$/,
	/^\*\*(.*)\*\*$/,
	/^__(.*)__$/,
	/^\*(.*)\*$/,
	/^_(.*)_$/,
	/^`(.*)`$/,
];

function isThematicBreak(line: string): boolean {
	return /^ {0,3}((?:-\s*){3,}|(?:_\s*){3,}|(?:\*\s*){3,})$/.test(line);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
