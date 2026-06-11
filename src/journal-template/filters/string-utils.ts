// Copied from obsidian-clipper src/utils/string-utils.ts @ 372d420 (only the
// helpers the copied filters need).
export function escapeMarkdown(str: string): string {
	return str.replace(/([[\]])/g, '\\$1');
}
