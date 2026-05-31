import type { ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { ShimmerPalette } from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import { shimmerSegments } from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	RoutingDecision,
	RouterConfig,
	RouterPinByProfile,
	RouterThinkingByProfile,
} from "../types";
import {
	shortenModelId,
	THINKING_COLOR,
	THINKING_ICON,
	PROFILE_PALETTE,
	makeTierPalette,
} from "./theme";
import { formatPinSummary } from "./profile";

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
