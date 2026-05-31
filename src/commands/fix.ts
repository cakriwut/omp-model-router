import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { RouterTier } from "../types";
import type { Actions } from "./shared";
import { ROUTER_TIERS } from "../config";

const TIER_SET: readonly string[] = ROUTER_TIERS;

export const handleFix = (
	state: RouterState,
	actions: Actions,
) => async (args: string[], ctx: ExtensionContext) => {
	if (args.length !== 1) {
		ctx.ui.notify("Usage: /router fix <high|medium|low>", "error");
		return;
	}
	const tier = args[0]?.toLowerCase();
	if (!TIER_SET.includes(tier)) {
		ctx.ui.notify("Usage: /router fix <high|medium|low>", "error");
		return;
	}
	if (!state.lastDecision) {
		ctx.ui.notify("No recent routing decision to fix.", "warning");
		return;
	}
	state.pinnedTierByProfile[state.lastDecision.profile] = tier as RouterTier;
	actions.persistState();
	actions.updateStatus(ctx);
	ctx.ui.notify(
		`Router decision corrected. ${state.lastDecision.profile} is now pinned to ${tier}.`,
		"info",
	);
};
