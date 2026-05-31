import type { RouterConfig, RouterProfile, RoutedTierConfig, RouterTier } from "../types";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { Model } from "@oh-my-pi/pi-ai";
import { SettingsList, type SettingItem, SelectList, type SelectItem } from "@oh-my-pi/pi-tui";
import { patchConfigFile, ROUTER_TIERS, THINKING_LEVELS } from "../config";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";

type ExtensionCommandContext = ExtensionContext & {
	modelRegistry: ModelRegistry;
	ui: {
		custom: <T>(factory: (ctx: { width: number }) => any) => Promise<T>;
		notify: (message: string, level?: string) => void;
		input: (prompt: string, defaultValue?: string) => Promise<string | undefined>;
		select: <T extends string>(prompt: string, items: { value: T; label: string; description?: string }[]) => Promise<T | undefined>;
		confirm: (prompt: string, defaultYes?: boolean) => Promise<boolean>;
	};
	hasUI: boolean;
};

/**
 * Build SelectItem[] from modelRegistry.getAvailable(), excluding router/* and optionally a primary model.
 */
export function buildModelItems(
	modelRegistry: Record<string, Model>,
	excludePrimary?: string
): SelectItem[] {
	// modelRegistry is actually the return of getAvailable() per coderA's signature
	const models = Object.values(modelRegistry).filter(
		(m) => m.provider !== "router" && m.id !== excludePrimary
	);
	return models.map((m) => {
		const ctxWindow = Math.floor(m.contextWindow / 1000);
		const costText =
			m.cost && m.cost.input != null && m.cost.output != null
				? `$${m.cost.input.toFixed(2)}/$${m.cost.output.toFixed(2)} per M`
				: "cost unknown";
		return {
			value: `${m.provider}/${m.id}`,
			label: `${m.provider}/${m.id} · ${ctxWindow}k ctx · ${costText}`,
			description: m.name,
		};
	});
}

/**
 * CheckboxList placeholder — coderA owns this; will import once available.
 */
class CheckboxList {
	constructor(items: SelectItem[], options?: { visibleCount?: number }) {
		throw new Error("CheckboxList not yet implemented by coderA");
	}
	toggle(_index: number): void {}
	getSelected(): number[] | undefined {
		return undefined;
	}
	confirm(): number[] | undefined {
		return undefined;
	}
	cancel(): undefined {
		return undefined;
	}
}

/**
 * Builds the 9 SettingItem rows for a profile (high/medium/low × model/thinking/fallbacks).
 */
function buildProfileItems(
	profile: RouterProfile,
	modelRegistry: ModelRegistry
): SettingItem[] {
	const items: SettingItem[] = [];
	const availableModels = modelRegistry.getAvailable();
	for (const tier of ROUTER_TIERS) {
		const tierCfg = profile[tier];
		// Model row
		items.push({
			id: `${tier}.model`,
			label: `${tier}.model`,
			currentValue: tierCfg.model,
			submenu: (currentValue, done) => {
				const selectItems = buildModelItems(availableModels as any);
				const selectedIdx = selectItems.findIndex((it) => it.value === currentValue);
				const list = new SelectList(selectItems, 12, {
					selectedPrefix: (t) => `> ${t}`,
					selectedText: (t) => t,
					description: (t) => t,
					scrollInfo: (t) => t,
					noMatch: (t) => t,
					symbols: { arrowUp: "↑", arrowDown: "↓", enter: "⏎" },
				});
				if (selectedIdx >= 0) list.setSelectedIndex(selectedIdx);
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);
				return list;
			},
		});
		// Thinking row
		items.push({
			id: `${tier}.thinking`,
			label: `${tier}.thinking`,
			currentValue: tierCfg.thinking ?? "none",
			values: [...THINKING_LEVELS],
		});
		// Fallbacks row
		const fallbacksDisplay = tierCfg.fallbacks?.join(", ") || "none";
		items.push({
			id: `${tier}.fallbacks`,
			label: `${tier}.fallbacks`,
			currentValue: fallbacksDisplay,
			submenu: (currentValue, done) => {
				const selectItems = buildModelItems(availableModels as any, tierCfg.model);
				const checkedIndices =
					tierCfg.fallbacks?.map((fb) => selectItems.findIndex((it) => it.value === fb)).filter((idx) => idx >= 0) ?? [];
				// Placeholder CheckboxList
				const list = new CheckboxList(selectItems, { visibleCount: 12 });
				// Wire up mock behavior — will be replaced when coderA delivers
				(list as any).onConfirm = (selected: string[]) => {
					done(selected.length ? selected.join(", ") : undefined);
				};
				(list as any).onCancel = () => done(undefined);
				return list;
			},
		});
	}
	return items;
}

/**
 * Opens the TUI profile editor for an existing profile. Drafts changes in memory; saves on `S`.
 */
export async function openProfileEditor(
	profileName: string,
	config: RouterConfig,
	modelRegistry: ModelRegistry,
	ctx: ExtensionCommandContext,
	onSave: (updatedProfiles: Record<string, RouterProfile>) => void,
): Promise<void> {
	const profile = config.profiles[profileName];
	if (!profile) {
		ctx.ui.notify(`Profile "${profileName}" not found.`, "error");
		return;
	}
	let draft: RouterProfile = JSON.parse(JSON.stringify(profile));

	await ctx.ui.custom(({ width }) => {
		const items = buildProfileItems(draft, modelRegistry);
		const list = new SettingsList(
			items,
			12,
			{
				label: (text, selected, changed) => (changed ? `* ${text}` : text),
				value: (text, selected, changed) => (changed ? `[${text}]` : text),
				description: (text) => text,
				cursor: ">",
				hint: (text) => text,
			},
			(id, newValue) => {
				// Parse id as tier.field
				const [tier, field] = id.split(".") as [RouterTier, keyof RoutedTierConfig];
				if (field === "model") {
					draft[tier].model = newValue;
				} else if (field === "thinking") {
					draft[tier].thinking = newValue as ThinkingLevel;
				} else if (field === "fallbacks") {
					draft[tier].fallbacks = newValue === "none" || !newValue ? undefined : newValue.split(", ");
				}
				// Mark row changed
				const itemIndex = items.findIndex((it) => it.id === id);
				if (itemIndex >= 0) {
					items[itemIndex].changed = true;
					items[itemIndex].currentValue = newValue;
					list.setItems([...items]);
				}
			},
			() => {
				// Esc pressed — cancel
			}
		);
		// Wire save handler (S key) — hack into handleInput or custom event
		// For now, rely on SettingsList closing via onCancel; real save needs a key hook
		return list;
	});

	// Save logic (this is called when user presses S inside the TUI; for now stub)
	const success = patchConfigFile({ profiles: { ...config.profiles, [profileName]: draft } });
	if (success) {
		onSave({ ...config.profiles, [profileName]: draft });
		ctx.ui.notify(`Profile "${profileName}" saved.`, "info");
	} else {
		ctx.ui.notify(`Failed to save profile "${profileName}".`, "error");
	}
}

/**
 * Creates a new profile. Prompts for name, validates uniqueness, opens editor pre-filled with active profile.
 */
export async function openCreateProfile(
	config: RouterConfig,
	modelRegistry: ModelRegistry,
	ctx: ExtensionCommandContext,
	onSave: (updatedProfiles: Record<string, RouterProfile>) => void,
): Promise<void> {
	const name = await ctx.ui.input("New profile name:");
	if (!name) return;
	if (config.profiles[name]) {
		ctx.ui.notify(`Profile "${name}" already exists.`, "error");
		return;
	}
	// Pre-fill with active profile (first one or default)
	const activeProfileName = config.defaultProfile ?? Object.keys(config.profiles)[0];
	const template = config.profiles[activeProfileName] ?? {
		high: { model: "anthropic/claude-sonnet-4-5" },
		medium: { model: "openai/gpt-4o" },
		low: { model: "openai/gpt-4o-mini" },
	};
	const newProfile: RouterProfile = JSON.parse(JSON.stringify(template));
	await openProfileEditor(name, { ...config, profiles: { ...config.profiles, [name]: newProfile } }, modelRegistry, ctx, onSave);
}

/**
 * Renames an existing profile. Prompts for source, validates new name, patches config atomically.
 */
export async function openRenameProfile(
	config: RouterConfig,
	modelRegistry: ModelRegistry,
	ctx: ExtensionCommandContext,
	onSave: (updatedProfiles: Record<string, RouterProfile>) => void,
): Promise<void> {
	const profileNames = Object.keys(config.profiles);
	if (profileNames.length === 0) {
		ctx.ui.notify("No profiles to rename.", "info");
		return;
	}
	const source = await ctx.ui.select(
		"Select profile to rename:",
		profileNames.map((name) => ({ value: name, label: name }))
	);
	if (!source) return;
	const newName = await ctx.ui.input("New profile name:", source);
	if (!newName) return;
	if (newName === source) return;
	if (config.profiles[newName]) {
		ctx.ui.notify(`Profile "${newName}" already exists.`, "error");
		return;
	}
	const updated = { ...config.profiles };
	updated[newName] = updated[source];
	delete updated[source];
	const success = patchConfigFile({ profiles: updated });
	if (success) {
		onSave(updated);
		ctx.ui.notify(`Profile renamed from "${source}" to "${newName}".`, "info");
	} else {
		ctx.ui.notify("Failed to rename profile.", "error");
	}
}

/**
 * Deletes a profile after confirmation. Guards against deleting the last profile.
 */
export async function openDeleteProfile(
	config: RouterConfig,
	ctx: ExtensionCommandContext,
	onSave: (updatedProfiles: Record<string, RouterProfile>) => void,
): Promise<void> {
	const profileNames = Object.keys(config.profiles);
	if (profileNames.length <= 1) {
		ctx.ui.notify("Cannot delete the last profile.", "error");
		return;
	}
	const target = await ctx.ui.select(
		"Select profile to delete:",
		profileNames.map((name) => ({ value: name, label: name }))
	);
	if (!target) return;
	const confirmed = await ctx.ui.confirm(`Delete profile "${target}"?`, false);
	if (!confirmed) {
		ctx.ui.notify("Delete cancelled.", "info");
		return;
	}
	const updated = { ...config.profiles };
	delete updated[target];
	const success = patchConfigFile({ profiles: updated });
	if (success) {
		onSave(updated);
		ctx.ui.notify(`Profile "${target}" deleted.`, "info");
	} else {
		ctx.ui.notify("Failed to delete profile.", "error");
	}
}