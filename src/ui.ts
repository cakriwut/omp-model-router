import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { ShimmerPalette } from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import { shimmerSegments } from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import type {
	RoutingDecision,
	RouterConfig,
	RouterPinByProfile,
	RouterThinkingByProfile,
} from "./types";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";

// ─── Model name shortening ────────────────────────────────────────────────────

/**
 * Shorten a full provider/model ref to a human-readable short name.
 *
 * Examples:
 *   "amazon-bedrock/global.anthropic.claude-sonnet-4-6"  → "sonnet-4-6"
 *   "amazon-bedrock/global.anthropic.claude-opus-4-7"    → "opus-4-7"
 *   "amazon-bedrock/zai.glm-4.7"                         → "glm-4.7"
 *   "openai/gpt-4o"                                      → "gpt-4o"
 *   "amazon-bedrock/deepseek.v3.2"                       → "v3.2"
 */
export const shortenModelId = (provider: string, modelId: string): string => {
	// Strip version suffix patterns like "-20241022-v1:0", "-v1:0", ":0"
	const cleaned = modelId
		.replace(/-\d{8}-v\d+:\d+$/, "")
		.replace(/-v\d+:\d+$/, "")
		.replace(/:\d+$/, "");

	// Strip known vendor prefixes separated by dots.
	// A vendor prefix is a segment before a dot where the segment after the dot
	// starts with a letter (model names start with letters, version numbers don't).
	// Examples: "global.anthropic.claude-sonnet-4-6" → "claude-sonnet-4-6"
	//           "deepseek.v3.2" → "deepseek-v3.2" (no strip, "v3" starts with letter but is short version)
	//           "zai.glm-5" → "glm-5"
	let result = cleaned;

	// Known vendor prefixes to strip (first dot-separated segment)
	const vendorPrefixes = ["global", "anthropic", "amazon", "nvidia", "mistral", "zai", "moonshotai"];

	// Repeatedly strip leading vendor prefixes
	let changed = true;
	while (changed) {
		changed = false;
		const dotIdx = result.indexOf(".");
		if (dotIdx >= 0) {
			const prefix = result.slice(0, dotIdx).toLowerCase();
			if (vendorPrefixes.includes(prefix)) {
				result = result.slice(dotIdx + 1);
				changed = true;
			}
		}
	}

	// Replace remaining dots with hyphens (version separators like "v3.2" → "v3-2")
	result = result.replace(/\./g, "-");

	// Strip known boilerplate prefixes
	const stripped = result
		.replace(/^claude-/, "")
		.replace(/^anthropic-/, "");

	return stripped || result || modelId;
};

// ─── Thinking level → theme ───────────────────────────────────────────────────

const THINKING_COLOR: Partial<Record<ThinkingLevel, ThemeColor>> = {
	inherit: "dim",
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

const THINKING_ICON: Partial<Record<ThinkingLevel, string>> = {
	inherit: "○",
	off: "○",
	minimal: "◔",
	low: "◑",
	medium: "◑",
	high: "●",
	xhigh: "⬤",
};

// ─── Shimmer palettes ─────────────────────────────────────────────────────────

const PROFILE_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "accent",
	high: "accent",
	bold: true,
};

const makeTierPalette = (color: ThemeColor): ShimmerPalette => ({
	low: "dim",
	mid: color,
	high: color,
	bold: true,
});

// ─── Shimmer widget ───────────────────────────────────────────────────────────

interface ShimmerSegmentDef {
	text: string;
	palette: ShimmerPalette;
}

/**
 * Custom TUI component driving shimmer via setInterval + tui.requestRender().
 * Used as a widget so ANSI is preserved (setStatus strips ANSI via sanitizeStatusText).
 */
class ShimmerWidget {
	#tui: TUI;
	#theme: Theme;
	#segments: ShimmerSegmentDef[] = [];
	#suffix = "";
	#interval: ReturnType<typeof setInterval> | undefined;

	constructor(tui: TUI, theme: Theme) {
		this.#tui = tui;
		this.#theme = theme;
		this.#interval = setInterval(() => {
			this.#tui.requestRender();
		}, 80);
	}

	setContent(segments: ShimmerSegmentDef[], suffix: string): void {
		this.#segments = segments;
		this.#suffix = suffix;
	}

	render(_width: number): string[] {
		if (this.#segments.length === 0) return [];
		return [" " + shimmerSegments(this.#segments, this.#theme) + this.#suffix];
	}

	dispose(): void {
		if (this.#interval) {
			clearInterval(this.#interval);
			this.#interval = undefined;
		}
	}
}

let activeShimmerWidget: ShimmerWidget | undefined;
// ─── Format helpers ───────────────────────────────────────────────────────────

const getEffectiveThinking = (
	thinkingByProfile: RouterThinkingByProfile,
	profileName: string,
	decision: RoutingDecision,
): ThinkingLevel =>
	(thinkingByProfile[profileName]?.[decision.tier] ??
		decision.thinking) as ThinkingLevel;

const getDecisionFlags = (decision: RoutingDecision): string[] => {
	const flags: string[] = [];
	if (decision.isFallback) flags.push("fallback");
	if (decision.isContextTriggered) flags.push("ctx");
	if (decision.isBudgetForced) flags.push("budget");
	if (decision.isRuleMatched) flags.push("rule");
	if (decision.compression) flags.push("toon");
	return flags;
};

/** Format input/output cost tokens + dollar value. */
const formatCost = (theme: Theme, decision: RoutingDecision): string => {
	const u = decision.usage;
	if (!u) return "";
	const cost = u.cost ?? 0;
	// Always show token counts; cost only if non-zero
	const inK = (u.inputTokens / 1000).toFixed(1);
	const outK = (u.outputTokens / 1000).toFixed(1);
	const costStr = cost > 0 ? ` $${cost.toFixed(4)}` : "";
	return theme.fg("dim", ` ↑${inK}k ↓${outK}k${costStr}`);
};

export const formatDecision = (decision: RoutingDecision): string => {
	return `${decision.profile}: ${decision.tier} -> ${decision.targetProvider}/${decision.targetModelId} [${decision.thinking}] (${decision.reasoning})`;
};

export const formatPinSummary = (
	pinnedTierByProfile: RouterPinByProfile,
): string => {
	const entries = Object.entries(pinnedTierByProfile)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([profile, tier]) => `${profile}:${tier}`);
	return entries.length > 0 ? entries.join(", ") : "none";
};

export const formatThinkingSummary = (
	thinkingByProfile: RouterThinkingByProfile,
): string => {
	const entries = Object.entries(thinkingByProfile)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([profile, tierMap]) => {
			const tiers = Object.entries(tierMap)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([tier, level]) => `${tier}:${level}`);
			return `${profile}(${tiers.join(",")})`;
		});
	return entries.length > 0 ? entries.join(", ") : "none";
};

export const formatModelRef = (ref: string | undefined): string => {
	return ref ?? "none";
};

// ─── Status line rendering ────────────────────────────────────────────────────

/**
 * Build the animated status line text for the router.
 *
 * During streaming (isStreaming=true), shimmer sweeps across the profile
 * and model segments. When idle, the text is static with semantic coloring.
 *
 * Layout (active):
 *   ⬡ auto  ◑ sonnet-4-6  ↑1.2k ↓0.4k $0.0012  [fallback]
 *
 * Layout (idle/waiting):
 *   ⬡ auto  waiting…
 *
 * Layout (off):
 *   ○ auto (off)  openai/gpt-4o
 */
export const buildStatusText = (
	theme: Theme,
	routerEnabled: boolean,
	selectedProfile: string,
	pinnedTierByProfile: RouterPinByProfile,
	thinkingByProfile: RouterThinkingByProfile,
	lastDecision: RoutingDecision | undefined,
	lastNonRouterModel: string | undefined,
	isStreaming: boolean,
	compressionEnabled = false,
): string => {
	const activePin = pinnedTierByProfile[selectedProfile];
	const pinSuffix = activePin ? theme.fg("accent", ` ⬣${activePin}`) : "";

	if (!routerEnabled) {
		const offProfile = theme.fg("dim", ` ○ ${selectedProfile}${activePin ? ` ⬣${activePin}` : ""} (off)`);
		let model = "";
		if (lastNonRouterModel) {
			const slashIdx = lastNonRouterModel.indexOf("/");
			const shortModel = slashIdx >= 0
				? shortenModelId(lastNonRouterModel.slice(0, slashIdx), lastNonRouterModel.slice(slashIdx + 1))
				: lastNonRouterModel;
			model = theme.fg("dim", `  ${shortModel}`);
		}
		return offProfile + model;
	}

	const matchesProfile =
		lastDecision && lastDecision.profile === selectedProfile;
	const matchesPin = activePin ? lastDecision?.tier === activePin : true;

	if (!lastDecision || !matchesProfile || !matchesPin) {
		// No decision yet — profile label only
		const profileText = ` ⬡ ${selectedProfile}`;
		if (isStreaming) {
			return shimmerSegments(
				[{ text: profileText, palette: PROFILE_PALETTE }],
				theme,
			) + pinSuffix + theme.fg("dim", "  routing…");
		}
		const toonWait = compressionEnabled ? theme.fg("dim", " ⟨toon⟩") : "";
	return theme.fg("accent", profileText) + pinSuffix + toonWait + theme.fg("dim", "  waiting…");
	}

	const thinking = getEffectiveThinking(
		thinkingByProfile,
		selectedProfile,
		lastDecision,
	);
	const thinkingColor = THINKING_COLOR[thinking] ?? "muted";
	const thinkingIcon = THINKING_ICON[thinking] ?? "○";
	const shortModel = shortenModelId(
		lastDecision.targetProvider,
		lastDecision.targetModelId,
	);
	const flags = getDecisionFlags(lastDecision);
	const flagText =
		flags.length > 0
			? " " + flags.map((f) => theme.fg("warning", `[${f}]`)).join(" ")
			: "";

	const profileText = ` ⬡ ${selectedProfile}`;
	const modelText = `${thinkingIcon} ${shortModel}`;
	const costText = formatCost(theme, lastDecision);

	if (isStreaming) {
		const tierPalette = makeTierPalette(thinkingColor);
		return (
			shimmerSegments(
				[
					{ text: profileText, palette: PROFILE_PALETTE },
					{ text: "  ", palette: PROFILE_PALETTE },
					{ text: modelText, palette: tierPalette },
				],
				theme,
			) +
			pinSuffix +
			costText +
			flagText
		);
	}

	const toonTag = compressionEnabled ? theme.fg("dim", " ⟨toon⟩") : "";
	return (
		theme.fg("accent", profileText) +
		pinSuffix +
		toonTag +
		"  " +
		theme.fg(thinkingColor, modelText) +
		costText +
		flagText
	);
};

// ─── Widget rendering ─────────────────────────────────────────────────────────

export const updateStatus = (
	ctx: ExtensionContext,
	routerEnabled: boolean,
	selectedProfile: string,
	pinnedTierByProfile: RouterPinByProfile,
	thinkingByProfile: RouterThinkingByProfile,
	lastDecision: RoutingDecision | undefined,
	lastNonRouterModel: string | undefined,
	accumulatedCost: number,
	widgetEnabled: boolean,
	currentConfig: RouterConfig,
	isStreaming = false,
) => {
	const theme = ctx.ui.theme;

	if (isStreaming && routerEnabled) {
		ctx.ui.setStatus("router", undefined);

		const activePin = pinnedTierByProfile[selectedProfile];
		const pinSuffix = activePin ? theme.fg("accent", ` ⬣${activePin}`) : "";
		const matchesProfile = lastDecision?.profile === selectedProfile;
		const matchesPin = activePin ? lastDecision?.tier === activePin : true;

		let segments: ShimmerSegmentDef[];
		let suffix: string;

		if (!lastDecision || !matchesProfile || !matchesPin) {
			segments = [{ text: `⬡ ${selectedProfile}`, palette: PROFILE_PALETTE }];
			const toonRouting = currentConfig.historyCompression?.enabled ? theme.fg("dim", " ⟨toon⟩") : "";
			suffix = pinSuffix + toonRouting + theme.fg("dim", "  routing…");
		} else {
			const thinking = getEffectiveThinking(thinkingByProfile, selectedProfile, lastDecision);
			const thinkingColor = THINKING_COLOR[thinking] ?? "muted";
			const thinkingIcon = THINKING_ICON[thinking] ?? "○";
			const shortModel = shortenModelId(lastDecision.targetProvider, lastDecision.targetModelId);
			const tierPalette = makeTierPalette(thinkingColor);
			const costText = formatCost(theme, lastDecision);
			const flags = getDecisionFlags(lastDecision);
			const flagText = flags.length > 0
				? " " + flags.map((f) => theme.fg("warning", `[${f}]`)).join(" ")
				: "";

			segments = [
				{ text: `⬡ ${selectedProfile}`, palette: PROFILE_PALETTE },
				{ text: "  ", palette: PROFILE_PALETTE },
				{ text: `${thinkingIcon} ${shortModel}`, palette: tierPalette },
			];
			const toonStreamTag = currentConfig.historyCompression?.enabled ? theme.fg("dim", " ⟨toon⟩") : "";
			suffix = pinSuffix + toonStreamTag + costText + flagText;
		}

		if (activeShimmerWidget) {
			activeShimmerWidget.setContent(segments, suffix);
		} else {
			ctx.ui.setWidget("router", (tui: TUI, widgetTheme: Theme) => {
				activeShimmerWidget = new ShimmerWidget(tui, widgetTheme);
				activeShimmerWidget.setContent(segments, suffix);
				return activeShimmerWidget;
			});
		}
		return;
	}

	// Idle: dispose shimmer widget, show static status
	if (activeShimmerWidget) {
		activeShimmerWidget.dispose();
		activeShimmerWidget = undefined;
		ctx.ui.setWidget("router", undefined);
	}

	const text = buildStatusText(
		theme,
		routerEnabled,
		selectedProfile,
		pinnedTierByProfile,
		thinkingByProfile,
		lastDecision,
		lastNonRouterModel,
		false,
		currentConfig.historyCompression?.enabled ?? false,
	);
	ctx.ui.setStatus("router", text);

	if (!widgetEnabled) {
		ctx.ui.setWidget("router", undefined);
		return;
	}

	const statusProfile = selectedProfile;
	const activePin = pinnedTierByProfile[statusProfile];

	const widgetLines = [
		`Router: ${routerEnabled ? "enabled" : "disabled"}`,
		`Profile: ${statusProfile}${routerEnabled ? " (active)" : ""}`,
		`Pin: ${activePin ?? "auto"}`,
		`Session cost: $${accumulatedCost.toFixed(4)}` +
			(currentConfig.maxSessionBudget
				? ` / $${currentConfig.maxSessionBudget.toFixed(2)}`
				: ""),
	];

	if (lastDecision && lastDecision.profile === statusProfile) {
		const thinking = getEffectiveThinking(thinkingByProfile, statusProfile, lastDecision);
		const flags = getDecisionFlags(lastDecision);
		const flagsStr = flags.length > 0 ? ` [${flags.join(",")}]` : "";
		const u = lastDecision.usage;
		const usageStr = u
			? ` ↑${u.inputTokens.toLocaleString()} ↓${u.outputTokens.toLocaleString()}` +
			  (u.cacheReadTokens > 0 ? ` 📦${u.cacheReadTokens.toLocaleString()}` : "") +
			  ` $${(u.cost ?? 0).toFixed(4)}`
			: "";

		widgetLines.push(
			`Route: ${lastDecision.tier}${flagsStr} → ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${thinking})`,
			`Phase: ${lastDecision.phase}`,
			`Usage:${usageStr || " —"}`,
		);
	} else if (!routerEnabled && lastNonRouterModel) {
		widgetLines.push(`Fallback: ${lastNonRouterModel}`);
	}

	if (Object.keys(pinnedTierByProfile).length > 1) {
		widgetLines.push(`Pins: ${formatPinSummary(pinnedTierByProfile)}`);
	}

	ctx.ui.setWidget(
		"router",
		widgetLines.map((line) => theme.fg("dim", line)),
	);
};

// ─── Usage report rendering ───────────────────────────────────────────────────

export interface UsageReportInput {
	theme: Theme;
	selectedProfile: string;
	profile: RouterConfig["profiles"][string];
	debugHistory: RoutingDecision[];
	lastDecision: RoutingDecision | undefined;
	accumulatedCost?: number;
	accumulatedOriginalTokens?: number;
	accumulatedCompressedTokens?: number;
	accumulatedTokensSaved?: number;
	accumulatedCacheReadTokens?: number;
	maxSessionBudget?: number;
	modelRegistry: { find(provider: string, modelId: string): { cost?: unknown } | undefined };
	compression?: {
		enabled: boolean;
		requestCount: number;
		totalOriginalChars: number;
		totalCompressedChars: number;
	};
}

/**
 * Render the /router usage report — stacked tier distribution bar,
 * per-model usage counts and tracked costs. Co-located with other
 * format helpers so widget and usage display stay in sync.
 */
export const renderUsageReport = (opts: UsageReportInput): string => {
	const {
		theme,
		selectedProfile,
		profile,
		debugHistory,
		lastDecision,
		accumulatedCost,
		maxSessionBudget,
		modelRegistry,
	} = opts;
	const BAR_WIDTH = 48;

	const tierColor = (tier: string, text: string): string => {
		if (tier === "high") return theme.fg("success", text);
		if (tier === "medium") return theme.fg("warning", text);
		return theme.fg("dim", text);
	};

	// Gather per-model usage from debug history for this profile
	const modelUsage: Record<string, { count: number; tier: string; cost: number }> = {};
	const tierCounts = { high: 0, medium: 0, low: 0 };
	for (const d of debugHistory) {
		if (d.profile !== selectedProfile) continue;
		const key = d.targetLabel;
		if (!modelUsage[key]) modelUsage[key] = { count: 0, tier: d.tier, cost: 0 };
		modelUsage[key].count++;
		modelUsage[key].cost += d.usage?.cost ?? 0;
		if (d.tier in tierCounts) tierCounts[d.tier as keyof typeof tierCounts]++;
	}
	const totalDecisions = tierCounts.high + tierCounts.medium + tierCounts.low;

	// Header line: profile + cost
	// Use authoritative accumulatedCost if provided (avoids undercount from
	// debug-history cap). Debug-history per-model breakdown is still shown.
	const sessionCost = Object.values(modelUsage).reduce((s, m) => s + m.cost, 0);
	const headerCost = accumulatedCost ?? sessionCost;
	const costStr = maxSessionBudget
		? `$${headerCost.toFixed(4)} / $${maxSessionBudget.toFixed(2)}`
		: `$${headerCost.toFixed(4)}`;
	const headerLeft = `Router: ${selectedProfile}`;
	const headerPad = Math.max(1, BAR_WIDTH + 2 - headerLeft.length - costStr.length);
	const headerLine = `${headerLeft}${" ".repeat(headerPad)}${costStr}`;

	// Stacked distribution bar + label line
	let barLine: string;
	let labelLine: string;
	if (totalDecisions > 0) {
		const highWidth = Math.round((tierCounts.high / totalDecisions) * BAR_WIDTH);
		const mediumWidth = Math.round((tierCounts.medium / totalDecisions) * BAR_WIDTH);
		const lowWidth = Math.max(0, BAR_WIDTH - highWidth - mediumWidth);
		barLine =
			tierColor("high", "█".repeat(highWidth)) +
			tierColor("medium", "█".repeat(mediumWidth)) +
			tierColor("low", "█".repeat(lowWidth)) +
			` ${totalDecisions} decisions`;

		const highPct = Math.round((tierCounts.high / totalDecisions) * 100);
		const medPct = Math.round((tierCounts.medium / totalDecisions) * 100);
		const lowPct = Math.round((tierCounts.low / totalDecisions) * 100);
		const highLabel = `high ${highPct}%`;
		const medLabel = `medium ${medPct}%`;
		const lowLabel = `low ${lowPct}%`;
		const hlPad = Math.max(0, Math.floor((highWidth - highLabel.length) / 2));
		const hlEnd = Math.max(0, highWidth - hlPad - highLabel.length);
		const mlPad = Math.max(0, Math.floor((mediumWidth - medLabel.length) / 2));
		const mlEnd = Math.max(0, mediumWidth - mlPad - medLabel.length);
		const llPad = Math.max(0, Math.floor((lowWidth - lowLabel.length) / 2));
		labelLine =
			" ".repeat(hlPad) + tierColor("high", highLabel) +
			" ".repeat(hlEnd) +
			" ".repeat(mlPad) + tierColor("medium", medLabel) +
			" ".repeat(mlEnd) +
			" ".repeat(llPad) + tierColor("low", lowLabel);
	} else {
		barLine = theme.fg("dim", "░".repeat(BAR_WIDTH)) + " 0 decisions";
		labelLine = theme.fg("dim", "no routing history");
	}

	// Per-tier model lines
	const TIERS = ["high", "medium", "low"] as const;
	const modelLines: string[] = [];
	for (const tier of TIERS) {
		const tierConfig = profile[tier];
		try {
			const slashIdx = tierConfig.model.indexOf("/");
			const modelId = slashIdx >= 0 ? tierConfig.model.slice(slashIdx + 1) : tierConfig.model;
			const provider = slashIdx >= 0 ? tierConfig.model.slice(0, slashIdx) : "";
			const usageCount = modelUsage[tierConfig.model]?.count ?? 0;
			const trackedCost = modelUsage[tierConfig.model]?.cost ?? 0;
			const registeredModel = provider ? modelRegistry.find(provider, modelId) : undefined;
			const tierCostStr = registeredModel?.cost ? `$${trackedCost.toFixed(4)}` : "";
			modelLines.push(
				`  ${tierColor(tier, tier.toUpperCase().padEnd(8))}${modelId.padEnd(38)}${`${usageCount}x`.padStart(4)}   ${tierCostStr}`,
			);
			if (tierConfig.fallbacks?.length) {
				for (const fb of tierConfig.fallbacks) {
					const fbSlash = fb.indexOf("/");
					const fbId = fbSlash >= 0 ? fb.slice(fbSlash + 1) : fb;
					const fbUsage = modelUsage[fb]?.count ?? 0;
					modelLines.push(`  ${" ".repeat(8)}└ ${fbId.padEnd(36)}${`${fbUsage}x`.padStart(4)}`);
				}
			}
		} catch { /* ignore bad model ref */ }
	}

	const lines = [headerLine, barLine, labelLine, "", ...modelLines];
	if (lastDecision) {
		const triggerSuffix = lastDecision.compressionTriggerReason 
			? ` [${lastDecision.compressionTriggerReason === 'context_size' ? '⟨size⟩' : '⟨expiry⟩'}]`
			: (lastDecision.compressionCacheHit ? ' [cached]' : '');
		lines.push(
			"",
			`Last: ${tierColor(lastDecision.tier, lastDecision.tier)} → ${lastDecision.targetProvider}/${lastDecision.targetModelId} (${lastDecision.thinking})${triggerSuffix}`,
		);
	}

	// ── Compression stats ──────────────────────────────────────────────
	const comp = opts.compression;
	if (comp?.enabled) {
		lines.push("");
		if (comp.requestCount > 0) {
			const savingsPct = comp.totalOriginalChars > 0
				? Math.round((1 - comp.totalCompressedChars / comp.totalOriginalChars) * 100)
				: 0;
			// Estimate token savings (conservative: 4 chars/token)
			const savedTokens = Math.round((comp.totalOriginalChars - comp.totalCompressedChars) / 4);
			const savedK = (savedTokens / 1000).toFixed(1);
			lines.push(
				`  ${theme.fg("accent", "TOON")}    ${comp.requestCount} requests compressed | ${theme.fg("success", `↓${savingsPct}%`)} smaller | est. ~${savedK}k tokens saved`,
			);
		} else {
			lines.push(`  ${theme.fg("accent", "TOON")}    enabled (no compressions yet — history too short)`);
		}
	}

	// ── Accumulated token metrics ──────────────────────────────────────
	if (opts.accumulatedOriginalTokens || opts.accumulatedTokensSaved || opts.accumulatedCacheReadTokens) {
		lines.push("");
		const tokenSavings = opts.accumulatedTokensSaved || 0;
		const cacheTokens = opts.accumulatedCacheReadTokens || 0;
		if (tokenSavings > 0) {
			const savingsK = (tokenSavings / 1000).toFixed(1);
			lines.push(`  ${theme.fg("accent", "Savings")} ~${savingsK}k tokens from TOON compression`);
		}
		if (cacheTokens > 0) {
			const cacheK = (cacheTokens / 1000).toFixed(1);
			lines.push(`  ${theme.fg("accent", "Cache")} 📦${cacheK}k tokens read from cache`);
		}
	}

	return lines.join("\n");
};
