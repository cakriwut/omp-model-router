import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { RouterTier } from "../types";
import type { Actions } from "./shared";
import { ROUTER_TIERS } from "../config";
import { setScopedPin, DEFAULT_PIN_TIMEOUT_MS } from "../routing/pin";

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
	setScopedPin(state.scope, tier as RouterTier, "user", state.currentConfig);
	actions.persistState();
	actions.updateStatus(ctx);
	const ttl = state.currentConfig.pinTimeout ?? DEFAULT_PIN_TIMEOUT_MS;
	const mins = Math.round(ttl / 60_000);
	ctx.ui.notify(
		`Router decision corrected. Pinned to ${tier} for this session (decays in ~${mins} min).`,
		"info",
	);
};
