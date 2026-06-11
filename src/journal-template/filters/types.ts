// Mirrors the filter contract from obsidian-clipper src/types/types.ts @ 372d420.
// Vendored filters may return arrays; the template engine stringifies between
// pipeline steps the same way the clipper dispatcher does.
export type FilterFunction = (value: string, param?: string) => string | unknown[];

export interface ParamValidationResult {
	valid: boolean;
	error?: string;
}
