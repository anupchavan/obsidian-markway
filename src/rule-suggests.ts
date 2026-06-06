import {
	AbstractInputSuggest,
	App,
	Notice,
	SearchResult,
	TFolder,
	getAllTags,
	prepareFuzzySearch,
	renderResults,
	setIcon,
} from "obsidian";

interface SuggestItem {
	value: string;
	display: string;
	isWikilink?: boolean;
	matchResult?: SearchResult;
}

abstract class BaseSuggest extends AbstractInputSuggest<SuggestItem> {
	protected onSelectCallback: ((value: string) => void) | null = null;
	protected excludeValues: string[] = [];

	constructor(app: App, inputEl: HTMLInputElement | HTMLDivElement) {
		super(app, inputEl);
		this.limit = 50;
		// Obsidian keeps this private; Custom Views uses it for native property-value styling.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
		(this as any).suggestEl?.addClass("mod-property-value");
	}

	setExcludeValues(values: string[]): this {
		this.excludeValues = values;
		return this;
	}

	onSelectCb(callback: (value: string) => void): this {
		this.onSelectCallback = callback;
		return this;
	}

	selectHighlighted(): boolean {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
		const suggestEl = (this as any).suggestEl as HTMLElement | undefined;
		const selected = suggestEl?.querySelector(".suggestion-item.is-selected") as HTMLElement | null;
		if (!selected) {
			return false;
		}
		selected.click();
		return true;
	}

	selectSuggestion(item: SuggestItem, _event: MouseEvent | KeyboardEvent): void {
		this.onSelectCallback?.(item.value);
		this.close();
	}

	protected filterItems(items: SuggestItem[], query: string): SuggestItem[] {
		const filteredItems = this.excludeValues.length
			? items.filter((item) => !this.excludeValues.includes(item.value))
			: items;

		if (!query.trim()) {
			for (const item of filteredItems) {
				item.matchResult = undefined;
			}
			return filteredItems.slice(0, this.limit);
		}

		const fuzzy = prepareFuzzySearch(query);
		const results: Array<{ item: SuggestItem; score: number }> = [];
		for (const item of filteredItems) {
			const result = fuzzy(item.display);
			if (result) {
				item.matchResult = result;
				results.push({ item, score: result.score });
			}
		}

		results.sort((left, right) => left.score - right.score);
		return results.map((result) => result.item);
	}

	protected renderHighlightedText(element: HTMLElement, item: SuggestItem): void {
		if (item.matchResult) {
			renderResults(element, item.display, item.matchResult);
		} else {
			element.setText(item.display);
		}
	}
}

export class FileSuggest extends BaseSuggest {
	getSuggestions(query: string): SuggestItem[] {
		const items = this.app.vault.getMarkdownFiles().map((file) => {
			const pathWithoutExtension = file.path.replace(/\.md$/, "");
			return { value: pathWithoutExtension, display: pathWithoutExtension };
		});
		items.sort((left, right) => left.display.localeCompare(right.display));
		return this.filterItems(items, query);
	}

	renderSuggestion(item: SuggestItem, element: HTMLElement): void {
		element.addClass("mod-nowrap");
		this.renderHighlightedText(element, item);
	}
}

export class FolderSuggest extends BaseSuggest {
	getSuggestions(query: string): SuggestItem[] {
		const folders = this.allFolders(this.app.vault.getRoot());
		const items = [
			{ value: "/", display: "/" },
			...folders.map((folder) => ({ value: folder.path, display: folder.path })),
		];
		items.sort((left, right) => left.display.localeCompare(right.display));
		return this.filterItems(items, query);
	}

	renderSuggestion(item: SuggestItem, element: HTMLElement): void {
		element.addClass("mod-nowrap");
		this.renderHighlightedText(element, item);
	}

	private allFolders(folder: TFolder): TFolder[] {
		const folders: TFolder[] = [];
		for (const child of folder.children) {
			if (child instanceof TFolder) {
				folders.push(child);
				folders.push(...this.allFolders(child));
			}
		}
		return folders;
	}
}

export class TagSuggest extends BaseSuggest {
	getSuggestions(query: string): SuggestItem[] {
		const tags = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			for (const tag of cache ? getAllTags(cache) ?? [] : []) {
				tags.add(tag.replace(/^#+/, ""));
			}
		}

		const items = Array.from(tags)
			.sort()
			.map((tag) => ({ value: tag, display: tag }));
		return this.filterItems(items, query);
	}

	renderSuggestion(item: SuggestItem, element: HTMLElement): void {
		element.addClass("mod-nowrap");
		this.renderHighlightedText(element, item);
	}
}

export class PropertySuggest extends BaseSuggest {
	getSuggestions(query: string): SuggestItem[] {
		const properties = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!frontmatter) {
				continue;
			}
			for (const key of Object.keys(frontmatter)) {
				if (key !== "position") {
					properties.add(key);
				}
			}
		}

		const items = Array.from(properties)
			.sort()
			.map((property) => ({ value: property, display: property }));
		return this.filterItems(items, query);
	}

	renderSuggestion(item: SuggestItem, element: HTMLElement): void {
		element.addClass("mod-nowrap");
		this.renderHighlightedText(element, item);
	}
}

export class FrontmatterValueSuggest extends BaseSuggest {
	constructor(app: App, inputEl: HTMLInputElement | HTMLDivElement, private readonly propertyKey: string) {
		super(app, inputEl);
	}

	getSuggestions(query: string): SuggestItem[] {
		const values = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
			if (!frontmatter || !(this.propertyKey in frontmatter)) {
				continue;
			}

			const value = frontmatter[this.propertyKey] as unknown;
			const array = Array.isArray(value) ? value : [value];
			for (const item of array) {
				if (item !== null && item !== undefined) {
					const text = String(item).trim();
					if (text) {
						values.add(text);
					}
				}
			}
		}

		const items = Array.from(values)
			.sort()
			.map((value) => {
				const wikilink = isWikilink(value);
				return {
					value,
					display: wikilink ? extractWikilinkDisplay(value) : value,
					isWikilink: wikilink,
				};
			});
		return this.filterItems(items, query);
	}

	renderSuggestion(item: SuggestItem, element: HTMLElement): void {
		if (!item.isWikilink) {
			element.addClass("mod-nowrap");
			this.renderHighlightedText(element, item);
			return;
		}

		element.addClass("mod-complex");
		const content = element.createDiv({ cls: "suggestion-content" });
		const title = content.createDiv({ cls: "suggestion-title" });
		this.renderHighlightedText(title, item);
		content.createDiv({ cls: "suggestion-note" });

		const aux = element.createDiv({ cls: "suggestion-aux" });
		const flair = aux.createSpan({ cls: "suggestion-flair" });
		setIcon(flair, "link");
	}
}

export function createSuggestForInput(
	app: App,
	inputEl: HTMLInputElement | HTMLDivElement,
	operator?: string,
	field?: string
): FileSuggest | FolderSuggest | TagSuggest | PropertySuggest | FrontmatterValueSuggest | null {
	if (!field) {
		return null;
	}
	if (field === "file links") {
		return new FileSuggest(app, inputEl);
	}
	if (field === "file.folder") {
		return new FolderSuggest(app, inputEl);
	}
	if (field === "file tags") {
		return new TagSuggest(app, inputEl);
	}
	if (field === "aliases") {
		return new FrontmatterValueSuggest(app, inputEl, "aliases");
	}
	if (field === "file") {
		if (operator === "links to" || operator === "does not link to") {
			return new FileSuggest(app, inputEl);
		}
		if (operator === "in folder" || operator === "is not in folder") {
			return new FolderSuggest(app, inputEl);
		}
		if (operator === "has tag" || operator === "does not have tag") {
			return new TagSuggest(app, inputEl);
		}
		if (operator === "has property" || operator === "does not have property") {
			return new PropertySuggest(app, inputEl);
		}
		return null;
	}
	if (!field.startsWith("file.") && field !== "file links" && field !== "file tags") {
		return new FrontmatterValueSuggest(app, inputEl, field);
	}
	return null;
}

export function isWikilink(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("[[") && trimmed.endsWith("]]") && trimmed.length > 4;
}

export function extractWikilinkTarget(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("[[") || !trimmed.endsWith("]]")) {
		return text;
	}
	const inner = trimmed.slice(2, -2);
	const pipe = inner.indexOf("|");
	return pipe >= 0 ? inner.slice(0, pipe) : inner;
}

export function extractWikilinkDisplay(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("[[") || !trimmed.endsWith("]]")) {
		return text;
	}
	const inner = trimmed.slice(2, -2);
	const pipe = inner.indexOf("|");
	return pipe >= 0 ? inner.slice(pipe + 1) : inner;
}

export function openWikilinkFile(app: App, linkTarget: string): void {
	const file = app.metadataCache.getFirstLinkpathDest(linkTarget, "");
	if (!file) {
		new Notice(`File not found: ${linkTarget}`);
		return;
	}

	const leaf = app.workspace.getLeaf("tab");
	void leaf.openFile(file).then(() => {
		new Notice(`Opened "${file.basename}"`);
	});
}
