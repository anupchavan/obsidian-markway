// @ts-nocheck -- vendored from obsidian-clipper @ 372d420; keep byte-close to upstream.
export const camel = (str: string): string => str
	.replace(/(?:^\w|[A-Z]|\b\w)/g, (letter, index) => 
		index === 0 ? letter.toLowerCase() : letter.toUpperCase()
	)
	.replace(/[\s_-]+/g, '');