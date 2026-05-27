import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ShimmerPalette } from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import { shimmerSegments } from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import type {
	RoutingDecision,
	RouterConfig,
	RouterPinByProfile,
	RouterThinkingByProfile,
} from "./types";
import type { Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";

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

	// Take everything after the last "." (vendor prefix separator)
	const afterDot = cleaned.includes(".")
		? cleaned.slice(cleaned.lastIndexOf(".") + 1)
		: cleaned;

	// If still has provider prefix like "anthropic.claude-...", strip to after last "."
	// already handled above. Strip known boilerplate prefixes.
	const stripped = afterDot
		.replace(/^claude-/, "")
		.replace(/^anthropic-/, "");

	return stripped || afterDot || modelId;
};

// ─── Thinking level → theme ───────────────────────────────────────────────────

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const THINKING_COLOR: Record<ThinkingLevel, ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

const THINKING_ICON: Record<ThinkingLevel, string> = {
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
): string => {
	const activePin = pinnedTierByProfile[selectedProfile];
	const pinSuffix = activePin ? theme.fg("accent", ` ⬣${activePin}`) : "";

	if (!routerEnabled) {
		const offProfile = theme.fg("dim", `○ ${selectedProfile}${activePin ? ` ⬣${activePin}` : ""} (off)`);
		const model = lastNonRouterModel
			? theme.fg("dim", `  ${lastNonRouterModel}`)
			: "";
		return offProfile + model;
	}

	const matchesProfile =
		lastDecision && lastDecision.profile === selectedProfile;
	const matchesPin = activePin ? lastDecision?.tier === activePin : true;

	if (!lastDecision || !matchesProfile || !matchesPin) {
		// No decision yet — profile label only
		const profileText = `⬡ ${selectedProfile}`;
		if (isStreaming) {
			return shimmerSegments(
				[{ text: profileText, palette: PROFILE_PALETTE }],
				theme,
			) + pinSuffix + theme.fg("dim", "  routing…");
		}
		return theme.fg("accent", profileText) + pinSuffix + theme.fg("dim", "  waiting…");
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

	const profileText = `⬡ ${selectedProfile}`;
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

	return (
		theme.fg("accent", profileText) +
		pinSuffix +
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
	const text = buildStatusText(
		ctx.ui.theme,
		routerEnabled,
		selectedProfile,
		pinnedTierByProfile,
		thinkingByProfile,
		lastDecision,
		lastNonRouterModel,
		isStreaming,
	);
	ctx.ui.setStatus("router", text);

	if (!widgetEnabled) {
		ctx.ui.setWidget("router", undefined);
		return;
	}

	const theme = ctx.ui.theme;
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
		const thinking = getEffectiveThinking(
			thinkingByProfile,
			statusProfile,
			lastDecision,
		);
		const flags = getDecisionFlags(lastDecision);
		const flagsStr = flags.length > 0 ? ` [${flags.join(",")}]` : "";
		const u = lastDecision.usage;
		const usageStr = u
			? ` ↑${u.inputTokens.toLocaleString()} ↓${u.outputTokens.toLocaleString()} $${(u.cost ?? 0).toFixed(4)}`
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
