// @ts-nocheck -- vendored from obsidian-clipper @ 372d420; keep byte-close to upstream.
export const unescape = (str: string): string => str
	.replace(/\\"/g, '"')
	.replace(/\\n/g, '\n');