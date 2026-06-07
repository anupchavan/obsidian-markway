export type FilterOperator =
	| "contains" | "does not contain"
	| "contains any of" | "does not contain any of"
	| "contains all of" | "does not contain all of"
	| "is" | "is not"
	| "is exactly" | "is not exactly"
	| "starts with" | "does not start with"
	| "ends with" | "does not end with"
	| "is empty" | "is not empty"
	| "links to" | "does not link to"
	| "in folder" | "is not in folder"
	| "has tag" | "does not have tag"
	| "has property" | "does not have property"
	| "on" | "not on"
	| "before" | "on or before"
	| "after" | "on or after"
	| "=" | "!=" | "≠" | "<" | "<=" | "≤" | ">" | ">=" | "≥";

export type FilterConjunction = "AND" | "OR" | "NOR";

export type PropertyType = "text" | "number" | "date" | "datetime" | "list" | "checkbox" | "file" | "unknown";

export interface Filter {
	type: "filter";
	field: string;
	operator: FilterOperator;
	value?: string;
}

export interface FilterGroup {
	type: "group";
	operator: FilterConjunction;
	conditions: Array<Filter | FilterGroup>;
}

export interface PropertyDef {
	key: string;
	type: PropertyType;
}

export interface RuleFile {
	name: string;
	basename: string;
	path: string;
	extension: string;
	parent?: { path: string } | null;
	stat: {
		size: number;
		ctime: number;
		mtime: number;
	};
}

export type FrontmatterValue =
	| string
	| number
	| boolean
	| Array<string | number | boolean>
	| null
	| undefined;

export type FrontmatterRecord = Record<string, FrontmatterValue>;

export interface RuleFileCache {
	tags?: Array<{ tag: string }>;
	links?: Array<{ link: string }>;
	frontmatter?: FrontmatterRecord;
}

export interface RuleMetadataCache {
	getFileCache(file: RuleFile): RuleFileCache | null | undefined;
	getFirstLinkpathDest?(linkpath: string, sourcePath: string): RuleFile | null;
}

export interface RuleApp {
	metadataCache: RuleMetadataCache;
	vault?: {
		getMarkdownFiles?(): RuleFile[];
	};
	metadataTypeManager?: {
		getAssignedType?(key: string): string | undefined;
	};
}
