import { App, FuzzyMatch, FuzzySuggestModal, setIcon } from "obsidian";
import {
	createSuggestForInput,
	extractWikilinkDisplay,
	extractWikilinkTarget,
	isWikilink,
	openWikilinkFile,
	type FileSuggest,
	type FolderSuggest,
	type FrontmatterValueSuggest,
	type PropertySuggest,
	type TagSuggest,
} from "./suggests";
import {
	fieldNeedsValue,
	getOperatorsForField,
	getPropertyIcon,
	getPropertyLabel,
	getPropertyType,
	scanRuleProperties,
	type Filter,
	type FilterConjunction,
	type FilterGroup,
	type FilterOperator,
	type PropertyDef,
	type PropertyType,
	type RuleApp,
} from "../rules";

interface ComboboxItem {
	label: string;
	value: string;
	icon?: string;
}

type PendingAutoOpen = { filter: Filter; action: "operator" | "value" } | null;

const pendingAutoOpenByRoot = new WeakMap<FilterGroup, PendingAutoOpen>();

export function renderJournalRules(
	container: HTMLElement,
	app: App,
	root: FilterGroup,
	onSave: () => void | Promise<void>,
	onRefresh: () => void,
	defaultFolder = "Journal"
): void {
	const rulesContainer = container.createDiv({ cls: "mw-rules-query-container" });
	new JournalRulesBuilder(app, root, onSave, onRefresh, defaultFolder).render(rulesContainer);
}

class ComboboxSuggestModal extends FuzzySuggestModal<ComboboxItem> {
	private clickOutsideHandler: ((event: MouseEvent) => void) | null = null;

	constructor(
		app: App,
		private readonly items: ComboboxItem[],
		private readonly selectedValue: string,
		private readonly onSelect: (value: string) => void,
		private readonly anchorEl?: HTMLElement
	) {
		super(app);
	}

	getItems(): ComboboxItem[] {
		return this.items;
	}

	getItemText(item: ComboboxItem): string {
		return item.label;
	}

	onOpen(): void {
		void super.onOpen();
		window.requestAnimationFrame(() => {
			const modalContainer = this.modalEl.closest(".modal-container");
			if (modalContainer) {
				modalContainer.addClass("mw-modal-container");
				modalContainer.removeClass("mod-dim");
				const modalBg = modalContainer.querySelector(".modal-bg");
				if (modalBg instanceof HTMLElement) {
					modalBg.addClass("mw-modal-bg-hidden");
				}
			}
		});

		this.modalEl.addClass("mw-suggestion-container", "mw-combobox");
		if (this.anchorEl) {
			const rect = this.anchorEl.getBoundingClientRect();
			this.modalEl.addClass("mw-combobox-positioned");
			this.modalEl.style.setProperty("--mw-combobox-left", `${rect.left}px`);
			this.modalEl.style.setProperty("--mw-combobox-top", `${rect.bottom + 5}px`);
		}

		const promptEl = this.modalEl.querySelector(".prompt-input-container");
		if (promptEl instanceof HTMLElement) {
			promptEl.addClass("mw-search-input-container");
			const searchIcon = promptEl.createDiv({ cls: "mw-search-icon" });
			setIcon(searchIcon, "search");
			promptEl.prepend(searchIcon);

			const input = promptEl.querySelector("input");
			if (input) {
				input.setAttribute("type", "search");
				input.setAttribute("placeholder", "Search...");
				input.addEventListener("input", () => {
					const clearButton = promptEl.querySelector(".search-input-clear-button");
					if (!(clearButton instanceof HTMLElement)) {
						return;
					}
					if (input.value.trim()) {
						clearButton.removeClass("mw-clear-button-hidden");
						clearButton.addClass("mw-clear-button-visible");
					} else {
						clearButton.removeClass("mw-clear-button-visible");
						clearButton.addClass("mw-clear-button-hidden");
					}
				});
				input.addEventListener("keydown", (event) => {
					if (event.key !== "Tab") {
						return;
					}
					event.preventDefault();
					if (event.shiftKey) {
						this.close();
						const previous = this.anchorEl?.previousElementSibling;
						if (previous instanceof HTMLElement) {
							previous.focus();
						}
					} else {
						const highlighted = this.modalEl.querySelector(".suggestion-item.is-selected");
						if (highlighted instanceof HTMLElement) {
							highlighted.click();
						} else {
							this.close();
						}
					}
				});
			}
		}

		const suggestionsEl = this.modalEl.querySelector(".suggestion-container");
		if (suggestionsEl instanceof HTMLElement) {
			suggestionsEl.addClass("mw-suggestion");
		}

		if (this.anchorEl) {
			this.anchorEl.setAttribute("tabindex", "0");
			window.requestAnimationFrame(() => this.anchorEl?.focus());
		}

		this.clickOutsideHandler = (event: MouseEvent) => {
			const target = event.target as Node;
			const outsideModal = !this.modalEl.contains(target) && this.modalEl !== target;
			const outsideAnchor = this.anchorEl !== target && !this.anchorEl?.contains(target);
			if (outsideModal && outsideAnchor) {
				this.close();
			}
		};
		window.setTimeout(() => {
			this.modalEl.doc.addEventListener("mousedown", this.clickOutsideHandler!);
		}, 0);
	}

	renderSuggestion(match: FuzzyMatch<ComboboxItem>, element: HTMLElement): void {
		const item = match.item;
		element.addClass("mw-suggestion-item", "mw-mod-complex", "mw-mod-toggle");
		if (item.value === this.selectedValue) {
			const checked = element.createDiv({ cls: "mw-suggestion-icon mw-mod-checked" });
			setIcon(checked, "check");
		}
		if (item.icon) {
			const iconDiv = element.createDiv({ cls: "mw-suggestion-icon" });
			const flair = iconDiv.createSpan({ cls: "mw-suggestion-flair" });
			setIcon(flair, item.icon);
		}
		const content = element.createDiv({ cls: "mw-suggestion-content" });
		content.createDiv({ cls: "mw-suggestion-title", text: item.label });
	}

	onChooseItem(item: ComboboxItem): void {
		this.onSelect(item.value);
	}

	onClose(): void {
		if (this.clickOutsideHandler) {
			this.modalEl.doc.removeEventListener("mousedown", this.clickOutsideHandler);
			this.clickOutsideHandler = null;
		}
		if (this.anchorEl) {
			const expression = this.anchorEl.closest(".mw-filter-expression");
			removeFocusClasses(this.anchorEl, expression instanceof HTMLElement ? expression : null);
		}

		const modalContainer = this.modalEl.closest(".modal-container");
		if (modalContainer) {
			modalContainer.removeClass("mw-modal-container");
			modalContainer.addClass("mod-dim");
			const modalBg = modalContainer.querySelector(".modal-bg");
			if (modalBg instanceof HTMLElement) {
				modalBg.removeClass("mw-modal-bg-hidden");
			}
		}
		super.onClose();
	}
}

class JournalRulesBuilder {
	private readonly availableProperties: PropertyDef[];

	constructor(
		private readonly app: App,
		private readonly root: FilterGroup,
		private readonly onSave: () => void | Promise<void>,
		private readonly onRefresh: () => void,
		private readonly defaultFolder: string
	) {
		this.availableProperties = scanRuleProperties(app as RuleApp);
	}

	private get pendingAutoOpen(): PendingAutoOpen {
		return pendingAutoOpenByRoot.get(this.root) ?? null;
	}

	private set pendingAutoOpen(value: PendingAutoOpen) {
		if (value) {
			pendingAutoOpenByRoot.set(this.root, value);
		} else {
			pendingAutoOpenByRoot.delete(this.root);
		}
	}

	render(container: HTMLElement): void {
		this.renderGroup(container, this.root, true);
	}

	private renderGroup(container: HTMLElement, group: FilterGroup, isRoot = false): void {
		const groupDiv = container.createDiv({ cls: "mw-filter-group" });
		const header = groupDiv.createDiv({ cls: "mw-filter-group-header" });

		const labelMap: Record<FilterConjunction, string> = {
			AND: "All the following are true",
			OR: "Any of the following are true",
			NOR: "None of the following are true",
		};
		const valueMap: Record<FilterConjunction, string> = {
			AND: "and",
			OR: "or",
			NOR: "not",
		};
		const reverseValueMap: Record<string, FilterConjunction> = {
			and: "AND",
			or: "OR",
			not: "NOR",
		};

		const select = header.createEl("select", { cls: "mw-conjunction dropdown" });
		for (const operator of ["AND", "OR", "NOR"] as const) {
			select.createEl("option", { attr: { value: valueMap[operator] }, text: labelMap[operator] });
		}
		select.value = valueMap[group.operator] ?? "and";
		select.onchange = () => {
			group.operator = reverseValueMap[select.value] ?? "AND";
			void this.saveAndRefresh();
		};

		const statementsContainer = groupDiv.createDiv({ cls: "mw-filter-group-statements" });
		if (!group.conditions.length) {
			const rowWrapper = statementsContainer.createDiv({ cls: "mw-filter-row" });
			rowWrapper.createSpan({ cls: "mw-conjunction", text: "Where" });
			this.renderFilterRow(rowWrapper, this.defaultFilter(), group, -1, true);
		} else {
			group.conditions.forEach((condition, index) => {
				const rowWrapper = statementsContainer.createDiv({ cls: "mw-filter-row" });
				rowWrapper.createSpan({
					cls: "mw-conjunction",
					text: index === 0 ? "Where" : group.operator === "AND" ? "and" : "or",
				});

				if (condition.type === "group") {
					rowWrapper.addClass("mw-mod-group");
					this.renderGroup(rowWrapper, condition);
					const nestedHeader = rowWrapper.querySelector(".mw-filter-group-header");
					if (nestedHeader instanceof HTMLElement) {
						const actions = nestedHeader.createDiv({ cls: "mw-filter-group-header-actions" });
						createDeleteButton(actions, () => {
							group.conditions.splice(index, 1);
							void this.saveAndRefresh();
						});
					}
				} else {
					this.renderFilterRow(rowWrapper, condition, group, index);
				}
			});
		}

		const actionsDiv = groupDiv.createDiv({ cls: "mw-filter-group-actions" });
		this.createSimpleButton(actionsDiv, "plus", "Add filter", () => {
			group.conditions.push(this.defaultFilter());
			void this.saveAndRefresh();
		});
		this.createSimpleButton(actionsDiv, "plus", "Add filter group", () => {
			group.conditions.push({ type: "group", operator: "AND", conditions: [] });
			void this.saveAndRefresh();
		});
		if (isRoot) {
			this.createSimpleButton(actionsDiv, "rotate-ccw", "Reset", () => {
				group.operator = "AND";
				group.conditions.splice(0, group.conditions.length, this.defaultFilter());
				void this.saveAndRefresh();
			});
		}
	}

	private renderFilterRow(
		row: HTMLElement,
		filter: Filter,
		parentGroup: FilterGroup,
		index: number,
		isPlaceholder = false
	): void {
		const statement = row.createDiv({ cls: "mw-filter-statement" });
		const expression = statement.createDiv({ cls: "mw-filter-expression metadata-property" });
		const currentType = getPropertyType(this.availableProperties, filter.field);
		let placeholderAdded = false;

		const propertyButton = createComboboxButton(
			expression,
			getPropertyLabel(filter.field),
			getPropertyIcon(filter.field, currentType)
		);
		const openPropertyModal = () => {
			addFocusClasses(propertyButton, expression);
			this.openCombobox(
				this.availableProperties.map((property) => ({
					label: getPropertyLabel(property.key),
					value: property.key,
					icon: getPropertyIcon(property.key, property.type),
				})),
				filter.field,
				(newValue) => {
					const newType = getPropertyType(this.availableProperties, newValue);
					const newOperator = getOperatorsForField(newValue, newType)[0] ?? "is";
					const targetFilter = this.ensureFilterInGroup(
						filter,
						parentGroup,
						isPlaceholder,
						placeholderAdded,
						index
					);
					placeholderAdded = true;
					targetFilter.field = newValue;
					targetFilter.operator = newOperator;
					targetFilter.value = "";
					this.pendingAutoOpen = { filter: targetFilter, action: "operator" };
					void this.saveAndRefresh();
				},
				propertyButton
			);
		};
		setupComboboxButtonHandlers(propertyButton, openPropertyModal);

		const validOperators = getOperatorsForField(filter.field, currentType);
		if (!validOperators.includes(filter.operator)) {
			filter.operator = validOperators[0] ?? "is";
		}
		const operatorButton = createComboboxButton(expression, filter.operator);
		const openOperatorModal = () => {
			addFocusClasses(operatorButton, expression);
			this.openCombobox(
				validOperators.map((operator) => ({ label: operator, value: operator })),
				filter.operator,
				(newValue) => {
					const targetFilter = this.ensureFilterInGroup(
						filter,
						parentGroup,
						isPlaceholder,
						placeholderAdded,
						index
					);
					placeholderAdded = true;
					targetFilter.operator = newValue as FilterOperator;
					if (!fieldNeedsValue(targetFilter.operator)) {
						targetFilter.value = "";
					} else {
						this.pendingAutoOpen = { filter: targetFilter, action: "value" };
					}
					void this.saveAndRefresh();
				},
				operatorButton
			);
		};
		setupComboboxButtonHandlers(operatorButton, openOperatorModal);

		if (this.pendingAutoOpen?.filter === filter && this.pendingAutoOpen.action === "operator") {
			this.pendingAutoOpen = null;
			addFocusClasses(operatorButton, expression);
			window.setTimeout(() => openOperatorModal(), 50);
		}

		const handleDelete = () => {
			if (!isPlaceholder) {
				parentGroup.conditions.splice(index, 1);
			}
			void this.saveAndRefresh();
		};

		if (fieldNeedsValue(filter.operator)) {
			const rhs = expression.createDiv({ cls: "mw-filter-rhs-container metadata-property-value" });
			createFilterValueInput(
				rhs,
				currentType,
				filter.value,
				(value) => {
					const targetFilter = this.ensureFilterInGroup(
						filter,
						parentGroup,
						isPlaceholder,
						placeholderAdded,
						index
					);
					placeholderAdded = true;
					targetFilter.value = value;
					void this.save();
				},
				filter.operator,
				this.app,
				filter.field
			);

			if (this.pendingAutoOpen?.filter === filter && this.pendingAutoOpen.action === "value") {
				this.pendingAutoOpen = null;
				window.setTimeout(() => {
					const focusTarget = rhs.querySelector("input, .mw-multi-select-input");
					if (focusTarget instanceof HTMLElement) {
						focusTarget.focus();
					}
				}, 50);
			}
		}

		const actions = expression.createDiv({ cls: "mw-filter-row-actions" });
		createDeleteButton(actions, handleDelete);
	}

	private ensureFilterInGroup(
		filter: Filter,
		parentGroup: FilterGroup,
		isPlaceholder: boolean,
		placeholderAdded: boolean,
		index: number
	): Filter {
		if (!isPlaceholder) {
			return filter;
		}
		if (!placeholderAdded) {
			const created = { ...filter };
			parentGroup.conditions.push(created);
			return created;
		}
		const target = parentGroup.conditions[index >= 0 ? index : parentGroup.conditions.length - 1];
		return target?.type === "filter" ? target : filter;
	}

	private openCombobox(
		items: ComboboxItem[],
		selectedValue: string,
		onSelect: (value: string) => void,
		anchorEl?: HTMLElement
	): void {
		new ComboboxSuggestModal(this.app, items, selectedValue, onSelect, anchorEl).open();
	}

	private createSimpleButton(container: HTMLElement, icon: string, text: string, onClick: () => void): void {
		const button = container.createDiv({ cls: "mw-text-icon-button", attr: { tabindex: "0" } });
		setIcon(button.createSpan({ cls: "mw-text-button-icon" }), icon);
		button.createSpan({ cls: "mw-text-button-label", text });
		button.onclick = (event) => {
			event.stopPropagation();
			onClick();
		};
		button.onkeydown = (event) => {
			if (event.key === " " || event.key === "Enter") {
				event.preventDefault();
				onClick();
			}
		};
	}

	private defaultFilter(): Filter {
		return { type: "filter", field: "file.folder", operator: "is", value: this.defaultFolder || "Journal" };
	}

	private async saveAndRefresh(): Promise<void> {
		await this.save();
		this.onRefresh();
	}

	private async save(): Promise<void> {
		await this.onSave();
	}
}

function createComboboxButton(container: HTMLElement, label: string, icon?: string): HTMLElement {
	const button = container.createDiv({ cls: "mw-combobox-button", attr: { tabindex: "0" } });
	if (icon) {
		const iconEl = button.createDiv({ cls: "mw-combobox-button-icon" });
		setIcon(iconEl, icon);
	}
	button.createDiv({ cls: "mw-combobox-button-label", text: label });
	setIcon(button.createDiv({ cls: "mw-combobox-button-chevron" }), "chevrons-up-down");
	return button;
}

function createDeleteButton(container: HTMLElement, onClick: (event: MouseEvent) => void): HTMLElement {
	const button = container.createEl("button", {
		cls: "clickable-icon",
		attr: { "aria-label": "Remove filter", type: "button" },
	});
	setIcon(button, "trash-2");
	button.onclick = (event) => {
		event.stopPropagation();
		onClick(event);
	};
	return button;
}

function addFocusClasses(button: HTMLElement, parent: HTMLElement): void {
	button.addClass("mw-has-focus");
	parent.addClass("mw-has-focus");
}

function removeFocusClasses(button: HTMLElement | null, parent: HTMLElement | null): void {
	button?.removeClass("mw-has-focus");
	parent?.removeClass("mw-has-focus");
}

function setupComboboxButtonHandlers(button: HTMLElement, onOpen: () => void): void {
	button.onclick = (event) => {
		event.preventDefault();
		event.stopPropagation();
		onOpen();
	};
	button.onkeydown = (event) => {
		if (event.key === " " || event.key === "Enter") {
			event.preventDefault();
			event.stopPropagation();
			onOpen();
		}
	};
}

function createFilterValueInput(
	container: HTMLElement,
	type: PropertyType,
	value: string | undefined,
	onChange: (value: string) => void,
	operator?: string,
	app?: App,
	field?: string
): HTMLInputElement | HTMLElement {
	const safeValue = value ?? "";
	if (needsMultiSelect(operator)) {
		return createMultiSelectInput(container, safeValue, onChange, operator, app, field);
	}

	if (type === "date" || type === "datetime") {
		const input = container.createEl("input", {
			type: type === "datetime" ? "datetime-local" : "date",
			value: safeValue,
			attr: { max: type === "datetime" ? "9999-12-31T23:59" : "9999-12-31" },
		});
		input.oninput = () => onChange(input.value);
		return input;
	}

	if (type === "number") {
		const input = container.createEl("input", { type: "number", value: safeValue });
		input.oninput = () => onChange(input.value);
		return input;
	}

	if (isWikilink(safeValue) && app) {
		return createWikilinkInput(container, safeValue, onChange, operator, app, field);
	}

	const input = container.createEl("input", { type: "text", value: safeValue });
	input.addClass("metadata-input", "metadata-input-text");
	input.placeholder = "Value...";
	input.oninput = () => onChange(input.value);
	attachSuggest(app, input, operator, field, (text) => {
		input.value = text;
		input.dispatchEvent(new Event("input"));
		onChange(text);
	});
	return input;
}

function createMultiSelectInput(
	container: HTMLElement,
	safeValue: string,
	onChange: (value: string) => void,
	operator?: string,
	app?: App,
	field?: string
): HTMLElement {
	const multiSelectContainer = container.createDiv({ cls: "mw-multi-select-container", attr: { tabindex: "-1" } });
	const values = safeValue ? safeValue.split(",").map((part) => part.trim()).filter(Boolean) : [];
	const input = multiSelectContainer.createDiv({
		cls: "mw-multi-select-input",
		attr: { contenteditable: "true", tabindex: "0", "data-placeholder": "Empty" },
	});
	let inlineSuggest: FileSuggest | FolderSuggest | TagSuggest | PropertySuggest | FrontmatterValueSuggest | null = null;

	const updatePlaceholder = () => {
		input.setAttribute("data-placeholder", values.length ? "" : "Empty");
	};
	const clearInput = () => {
		input.textContent = "";
		input.querySelector("br")?.remove();
	};
	const getPills = () => Array.from(multiSelectContainer.querySelectorAll<HTMLElement>(".mw-multi-select-pill"));
	const focusInput = () => input.focus();
	const focusPill = (index: number) => getPills()[index]?.focus();
	const focusLastPill = () => {
		const pills = getPills();
		pills[pills.length - 1]?.focus();
	};
	const acceptInputText = () => {
		const text = input.textContent?.trim() ?? "";
		if (!text) {
			return;
		}
		values.push(text);
		onChange(values.join(","));
		updatePills();
		clearInput();
		updatePlaceholder();
	};

	const setupPillNavigation = (pill: HTMLElement) => {
		pill.addEventListener("keydown", (event: KeyboardEvent) => {
			const pills = getPills();
			const currentIndex = pills.indexOf(pill);
			if (event.key === "Backspace" || event.key === "Delete") {
				event.preventDefault();
				event.stopPropagation();
				if (currentIndex >= 0) {
					values.splice(currentIndex, 1);
					onChange(values.join(","));
					updatePills();
					window.requestAnimationFrame(() => (values.length ? focusPill(Math.max(0, currentIndex - 1)) : focusInput()));
				}
			} else if ((event.key === "Tab" && !event.shiftKey) || event.key === "ArrowRight") {
				event.preventDefault();
				if (currentIndex < pills.length - 1) {
					focusPill(currentIndex + 1);
				} else {
					focusInput();
				}
			} else if (event.key === "ArrowLeft") {
				event.preventDefault();
				if (currentIndex > 0) {
					focusPill(currentIndex - 1);
				} else {
					focusInput();
				}
			} else if (event.key === "Tab" && event.shiftKey && currentIndex > 0) {
				event.preventDefault();
				focusPill(currentIndex - 1);
			}
		});
	};

	const updatePills = () => {
		for (const pill of getPills()) {
			pill.remove();
		}
		values.forEach((pillValue, index) => {
			createPill(multiSelectContainer, pillValue, () => {
				values.splice(index, 1);
				onChange(values.join(","));
				updatePills();
				updatePlaceholder();
				window.requestAnimationFrame(() => (values.length ? focusPill(Math.min(index, values.length - 1)) : focusInput()));
			}, setupPillNavigation, app);
		});
		multiSelectContainer.appendChild(input);
		updatePlaceholder();
	};

	multiSelectContainer.addEventListener("click", (event) => {
		if (event.target === multiSelectContainer) {
			event.preventDefault();
			input.focus();
		}
	});
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			acceptInputText();
			window.requestAnimationFrame(focusInput);
		} else if (event.key === "Tab" && !event.shiftKey) {
			if (inlineSuggest?.selectHighlighted()) {
				event.preventDefault();
			}
		} else if ((event.key === "Backspace" || event.key === "ArrowLeft") && !input.textContent?.trim()) {
			event.preventDefault();
			focusLastPill();
		}
	});
	input.addEventListener("paste", (event: ClipboardEvent) => {
		event.preventDefault();
		const pastedText = event.clipboardData?.getData("text") ?? "";
		const newValues = pastedText.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
		if (newValues.length) {
			values.push(...newValues);
			onChange(values.join(","));
			updatePills();
			clearInput();
			updatePlaceholder();
		}
	});

	let blurTimeout: number | null = null;
	input.addEventListener("blur", () => {
		blurTimeout = window.setTimeout(() => {
			blurTimeout = null;
			acceptInputText();
		}, 150);
	});

	if (app) {
		const suggest = createSuggestForInput(app, input, operator, field);
		if (suggest) {
			suggest.setExcludeValues(values);
			suggest.onSelectCb((text) => {
				if (blurTimeout) {
					window.clearTimeout(blurTimeout);
					blurTimeout = null;
				}
				const trimmed = text.trim();
				if (trimmed && !values.includes(trimmed)) {
					values.push(trimmed);
					onChange(values.join(","));
					updatePills();
					clearInput();
					updatePlaceholder();
					window.requestAnimationFrame(focusInput);
				}
			});
			inlineSuggest = suggest;
		}
	}

	updatePills();
	updatePlaceholder();
	return multiSelectContainer;
}

function createWikilinkInput(
	container: HTMLElement,
	safeValue: string,
	onChange: (value: string) => void,
	operator?: string,
	app?: App,
	field?: string
): HTMLElement {
	const input = container.createEl("input", { type: "text", value: safeValue });
	input.addClass("metadata-input", "metadata-input-text", "mw-hidden");
	input.placeholder = "Value...";
	input.oninput = () => onChange(input.value);

	const metadataLink = container.createDiv({ cls: "metadata-link" });
	const linkTarget = extractWikilinkTarget(safeValue);
	const resolved = app?.metadataCache.getFirstLinkpathDest(linkTarget, "");
	const linkEl = metadataLink.createDiv({
		cls: "metadata-link-inner internal-link",
		text: extractWikilinkDisplay(safeValue),
		attr: { "data-href": linkTarget, draggable: "true" },
	});
	if (!resolved) {
		linkEl.addClass("is-unresolved");
	}
	const flair = metadataLink.createDiv({ cls: "metadata-link-flair" });
	setIcon(flair, "pencil");

	const enterEditMode = () => {
		metadataLink.addClass("mw-hidden");
		input.removeClass("mw-hidden");
		input.focus();
		input.select();
	};
	linkEl.addEventListener("click", (event) => {
		event.stopPropagation();
		if (app) {
			openWikilinkFile(app, extractWikilinkTarget(input.value));
		}
	});
	flair.addEventListener("click", (event) => {
		event.stopPropagation();
		enterEditMode();
	});
	metadataLink.addEventListener("click", enterEditMode);
	input.addEventListener("blur", () => {
		if (!isWikilink(input.value)) {
			return;
		}
		metadataLink.removeClass("mw-hidden");
		input.addClass("mw-hidden");
		const newTarget = extractWikilinkTarget(input.value);
		const newResolved = app?.metadataCache.getFirstLinkpathDest(newTarget, "");
		linkEl.setText(extractWikilinkDisplay(input.value));
		linkEl.setAttribute("data-href", newTarget);
		linkEl.toggleClass("is-unresolved", !newResolved);
	});

	attachSuggest(app, input, operator, field, (text) => {
		input.value = text;
		input.dispatchEvent(new Event("input"));
		onChange(text);
	});
	return container;
}

function attachSuggest(
	app: App | undefined,
	input: HTMLInputElement,
	operator: string | undefined,
	field: string | undefined,
	onSelect: (value: string) => void
): void {
	const suggest = app ? createSuggestForInput(app, input, operator, field) : null;
	suggest?.onSelectCb(onSelect);
}

function createPill(
	container: HTMLElement,
	value: string,
	onRemove: () => void,
	onCreated?: (pill: HTMLElement) => void,
	app?: App
): void {
	const pill = container.createDiv({ cls: "mw-multi-select-pill", attr: { tabindex: "0" } });
	if (isWikilink(value) && app) {
		pill.addClass("mw-pill-wikilink");
		const linkTarget = extractWikilinkTarget(value);
		const resolved = app.metadataCache.getFirstLinkpathDest(linkTarget, "");
		const contentEl = pill.createDiv({ cls: "mw-multi-select-pill-content internal-link" });
		contentEl.toggleClass("is-unresolved", !resolved);
		contentEl.setAttribute("data-href", linkTarget);
		contentEl.setText(extractWikilinkDisplay(value));
		contentEl.addEventListener("click", (event) => {
			event.stopPropagation();
			event.preventDefault();
			openWikilinkFile(app, linkTarget);
		});
	} else {
		pill.createDiv({ cls: "mw-multi-select-pill-content", text: value });
	}

	const removeButton = pill.createDiv({ cls: "mw-multi-select-pill-remove-button" });
	setIcon(removeButton, "x");
	removeButton.onclick = (event) => {
		event.stopPropagation();
		onRemove();
	};
	onCreated?.(pill);
}

function needsMultiSelect(operator?: string): boolean {
	return operator === "contains any of"
		|| operator === "does not contain any of"
		|| operator === "contains all of"
		|| operator === "does not contain all of"
		|| operator === "is exactly"
		|| operator === "is not exactly"
		|| operator === "has tag"
		|| operator === "does not have tag";
}
