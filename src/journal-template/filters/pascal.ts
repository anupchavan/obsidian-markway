export const pascal = (str: string) => str
	.replace(/[\s_-]+(.)/g, (_match: string, c: string) => c.toUpperCase())
	.replace(/^(.)/, c => c.toUpperCase());
