// @ts-nocheck -- vendored from obsidian-clipper @ 372d420; keep byte-close to upstream.
export const snake = (str: string) => str
	.replace(/([a-z])([A-Z])/g, '$1_$2')
	.replace(/[\s-]+/g, '_')
	.toLowerCase();