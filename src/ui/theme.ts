import type { ShimmerPalette } from "@oh-my-pi/pi-coding-agent/modes/theme/shimmer";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent";
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

/**
 * Shorten a full `provider/modelId` ref string for compact display.
 * Splits on the first `/` then delegates to `shortenModelId`.
 */
export const shortenModelRef = (ref: string): string => {
	const slash = ref.indexOf("/");
	if (slash < 0) return shortenModelId("", ref);
	return shortenModelId(ref.slice(0, slash), ref.slice(slash + 1));
};

// ─── Thinking level → theme ───────────────────────────────────────────────────

export const THINKING_COLOR: Partial<Record<ThinkingLevel, ThemeColor>> = {
	inherit: "dim",
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
};

export const THINKING_ICON: Partial<Record<ThinkingLevel, string>> = {
	inherit: "○",
	off: "○",
	minimal: "◔",
	low: "◑",
	medium: "◑",
	high: "●",
	xhigh: "⬤",
};

// ─── Shimmer palettes ─────────────────────────────────────────────────────────

export const PROFILE_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "accent",
	high: "accent",
	bold: true,
};

export const makeTierPalette = (color: ThemeColor): ShimmerPalette => ({
	low: "dim",
	mid: color,
	high: color,
	bold: true,
});
