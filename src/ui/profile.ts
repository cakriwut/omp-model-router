import type {
	RoutingDecision,
	RouterPinByProfile,
	RouterThinkingByProfile,
} from "../types";

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
