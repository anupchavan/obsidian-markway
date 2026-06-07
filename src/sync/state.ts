import { hashJournalContent } from "./markdown";
import { sha256Hex } from "./primitives";
import type { JournalEntrySummary, JournalLink, SyncOptions } from "./types";

export function mergeSyncOptions(existing: SyncOptions | null, next: SyncOptions): SyncOptions {
	if (!existing) {
		return next;
	}

	return {
		includeNew: existing.includeNew || next.includeNew,
		silent: existing.silent === true && next.silent === true,
		migrateFrontmatter: existing.migrateFrontmatter === true || next.migrateFrontmatter === true,
	};
}

export function hasMatchingJournalSummary(link: JournalLink, summary: JournalEntrySummary): boolean {
	return Boolean(summary.updated)
		&& link.lastJournalUpdated === summary.updated
		&& link.title === summary.title;
}

export function hasMarkdownChangedSinceLastSync(link: JournalLink, markdown: string): boolean {
	return Boolean(link.lastMarkdownHash) && sha256Hex(markdown) !== link.lastMarkdownHash;
}

export function hasUnsyncedMarkdownContent(
	link: JournalLink,
	markdown: string,
	title: string,
	journalBody: string
): boolean {
	if (link.lastMarkdownHash) {
		return hasMarkdownChangedSinceLastSync(link, markdown);
	}
	return link.lastJournalHash !== "" && hashJournalContent(title, journalBody) !== link.lastJournalHash;
}
