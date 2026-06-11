// @ts-nocheck -- vendored from obsidian-clipper @ 372d420; keep byte-close to upstream.
export const kebab = (str: string): string => str
	.replace(/([a-z])([A-Z])/g, '$1-$2')
	.replace(/[\s_]+/g, '-')
	.toLowerCase();