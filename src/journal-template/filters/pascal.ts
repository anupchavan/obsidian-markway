// @ts-nocheck -- vendored from obsidian-clipper @ 372d420; keep byte-close to upstream.
export const pascal = (str: string) => str
	.replace(/[\s_-]+(.)/g, (_, c) => c.toUpperCase())
	.replace(/^(.)/, c => c.toUpperCase());