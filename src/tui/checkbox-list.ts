/**
 * CheckboxList — A TUI component for multi-select from a list of items.
 * Supports Space to toggle, Enter to confirm, Esc to cancel.
 * Includes scroll support for large lists (similar to SelectList).
 */

export interface CheckboxItem {
	value: string;
	label: string;
	description?: string;
}

export interface Component {
	render(): string;
	onInput(char: string): boolean;
}

/**
 * CheckboxList component for multi-select UI.
 * Users navigate with arrow keys, toggle with Space, confirm with Enter, cancel with Esc.
 */
export class CheckboxList implements Component {
	private items: CheckboxItem[];
	private checked: Set<string>;
	private selectedIndex: number = 0;
	private visibleStart: number = 0;
	private readonly visibleCount: number;

	onConfirm?: (selected: string[]) => void;
	onCancel?: () => void;

	constructor(items: CheckboxItem[], preChecked?: string[], visibleCount: number = 10) {
		this.items = items;
		this.checked = new Set(preChecked || []);
		this.visibleCount = Math.max(1, visibleCount);
		this.selectedIndex = 0;
		this.updateScrollPosition();
	}

	private updateScrollPosition(): void {
		// Ensure selected index is within visible range
		if (this.selectedIndex < this.visibleStart) {
			this.visibleStart = this.selectedIndex;
		} else if (this.selectedIndex >= this.visibleStart + this.visibleCount) {
			this.visibleStart = this.selectedIndex - this.visibleCount + 1;
		}
		// Clamp scroll position
		this.visibleStart = Math.max(0, Math.min(this.visibleStart, Math.max(0, this.items.length - this.visibleCount)));
	}

	render(): string {
		if (this.items.length === 0) {
			return "No items available.\n\n(Space: toggle · Enter: confirm · Esc: cancel)";
		}

		const lines: string[] = [];
		const visibleEnd = Math.min(this.visibleStart + this.visibleCount, this.items.length);

		for (let i = this.visibleStart; i < visibleEnd; i++) {
			const item = this.items[i];
			const isSelected = i === this.selectedIndex;
			const isChecked = this.checked.has(item.value);

			// Cursor, checkbox, and label
			const cursor = isSelected ? ">" : " ";
			const checkbox = isChecked ? "[✓]" : "[ ]";
			const label = item.label;

			// Highlight line if selected
			const line = `${cursor} ${checkbox} ${label}`;
			const renderedLine = isSelected ? `\x1b[7m${line}\x1b[0m` : line;
			lines.push(renderedLine);

			// Add description if present (indented below the item)
			if (item.description) {
				const descLine = `  ${item.description}`;
				lines.push(isSelected ? `\x1b[7m${descLine}\x1b[0m` : descLine);
			}
		}

		// Scroll indicator
		let scrollInfo = "";
		if (this.items.length > this.visibleCount) {
			const percentScroll = ((this.visibleStart / this.items.length) * 100).toFixed(0);
			scrollInfo = `\n(Showing ${visibleEnd - this.visibleStart}/${this.items.length} · ${percentScroll}% ↓)`;
		}

		const help = "\n\n(Space: toggle · Enter: confirm · Esc: cancel)";
		return lines.join("\n") + scrollInfo + help;
	}

	onInput(char: string): boolean {
		switch (char) {
			case " ": {
				// Toggle checkbox
				const item = this.items[this.selectedIndex];
				if (this.checked.has(item.value)) {
					this.checked.delete(item.value);
				} else {
					this.checked.add(item.value);
				}
				return true;
			}

			case "ArrowUp": {
				if (this.selectedIndex > 0) {
					this.selectedIndex--;
					this.updateScrollPosition();
				}
				return true;
			}

			case "ArrowDown": {
				if (this.selectedIndex < this.items.length - 1) {
					this.selectedIndex++;
					this.updateScrollPosition();
				}
				return true;
			}

			case "Enter": {
				// Confirm: return checked items in order
				const selected = this.items
					.filter((item) => this.checked.has(item.value))
					.map((item) => item.value);
				if (this.onConfirm) {
					this.onConfirm(selected);
				}
				return true;
			}

			case "Escape": {
				// Cancel
				if (this.onCancel) {
					this.onCancel();
				}
				return true;
			}

			default:
				return false;
		}
	}
}
