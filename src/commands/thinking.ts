import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { RouterState } from "../state";
import type { RouterTier } from "../types";
import type { Actions } from "./shared";
import { THINKING_LEVELS, ROUTER_TIERS, isThinkingLevel } from "../config";
import { resolveEffectivePin } from "../routing/pin";

const TIER_VALUES: readonly string[] = ["high", "medium", "low"];

export const handleThinking = (
	state: RouterState,
	actions: Actions,
) => async (args: string[], ctx: ExtensionContext) => {
	const currentProfile = state.selectedProfile;
	if (args.length === 0) {
		ctx.ui.notify(
			[
				`Profile: ${currentProfile}`,
				`Thinking overrides: ${JSON.stringify(state.thinkingByProfile[currentProfile] ?? {})}`,
				"Usage: /router thinking <level|auto>",
				"   or: /router thinking <tier> <level|auto>",
				"   or: /router thinking <profile> <tier> <level|auto>",
			].join("\n"),
			"info",
		);
		return;
	}

	let profileName = currentProfile;
	let tier: RouterTier | "all" | undefined = undefined;
	let levelValue = "";

	const levelValues: readonly string[] = ["auto", ...THINKING_LEVELS];

	if (args.length === 1) {
		levelValue = args[0];
		tier =
			resolveEffectivePin(state.scope, state.currentConfig) ??
			(state.lastDecision?.profile === profileName
				? state.lastDecision.tier
				: "medium");
	} else if (args.length === 2) {
		if (TIER_VALUES.includes(args[0]) || args[0] === "all") {
			tier = args[0] as RouterTier | "all";
			levelValue = args[1];
		} else {
			profileName = args[0];
			levelValue = args[1];
			tier =
				resolveEffectivePin(state.scope, state.currentConfig) ??
				(state.lastDecision?.profile === profileName
					? state.lastDecision.tier
					: "medium");
		}
	} else if (args.length === 3) {
		profileName = args[0];
		tier = args[1] as RouterTier | "all";
		levelValue = args[2];
	}

	if (!state.currentConfig.profiles[profileName]) {
		ctx.ui.notify(`Unknown router profile: ${profileName}`, "error");
		return;
	}
	if (tier !== "all" && !TIER_VALUES.includes(tier as string)) {
		ctx.ui.notify(
			`Invalid tier: ${tier}. Use high, medium, or low.`,
			"error",
		);
		return;
	}
	if (!levelValues.includes(levelValue)) {
		ctx.ui.notify(
			`Invalid thinking level: ${levelValue}. Use auto or: ${THINKING_LEVELS.join(", ")}`,
			"error",
		);
		return;
	}

	const nextLevel: ThinkingLevel | undefined =
		levelValue === "auto" || !isThinkingLevel(levelValue)
			? undefined
			: levelValue;
	if (tier === "all") {
		for (const t of ROUTER_TIERS) {
			if (!state.thinkingByProfile[profileName])
				state.thinkingByProfile[profileName] = {};
			if (nextLevel) state.thinkingByProfile[profileName]![t] = nextLevel;
			else delete state.thinkingByProfile[profileName]![t];
		}
	} else {
		if (!state.thinkingByProfile[profileName])
			state.thinkingByProfile[profileName] = {};
		if (nextLevel)
			state.thinkingByProfile[profileName]![tier as RouterTier] = nextLevel;
		else delete state.thinkingByProfile[profileName]![tier as RouterTier];
	}
	if (
		state.thinkingByProfile[profileName] &&
		Object.keys(state.thinkingByProfile[profileName]!).length === 0
	) {
		delete state.thinkingByProfile[profileName];
	}

	actions.persistState();
	actions.updateStatus(ctx);
	ctx.ui.notify(
		nextLevel
			? `Router profile ${profileName} thinking (${tier}) set to ${nextLevel}`
			: `Router profile ${profileName} thinking (${tier}) reset to config defaults`,
		"info",
	);
};
