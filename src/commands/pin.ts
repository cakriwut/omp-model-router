import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { RouterTier } from "../types";
import type { Actions } from "./shared";
import { ROUTER_PIN_VALUES } from "../config";
import { formatPinSummary } from "../ui";

const PIN_SET = ROUTER_PIN_VALUES as readonly string[];

export const handlePin = (
	state: RouterState,
	actions: Actions,
) => async (args: string[], ctx: ExtensionContext) => {
	const currentProfile = state.selectedProfile;
	if (args.length === 0) {
		ctx.ui.notify(
			[
				`Profile: ${currentProfile}`,
				`Pinned tier: ${state.pinnedTierByProfile[currentProfile] ?? "auto"}`,
				`Pins by profile: ${formatPinSummary(state.pinnedTierByProfile)}`,
				`Usage: /router pin <high|medium|low|auto>`,
				`   or: /router pin <profile> <high|medium|low|auto>`,
			].join("\n"),
			"info",
		);
		actions.updateStatus(ctx);
		return;
	}

	let profileName = currentProfile;
	let pinValue = "";

	if (args.length === 1) {
		pinValue = args[0];
	} else {
		profileName = args[0];
		pinValue = args[1];
	}

	if (!state.currentConfig.profiles[profileName]) {
		if (args.length === 2) {
			ctx.ui.notify(`Unknown router profile: ${profileName}`, "error");
			return;
		}
		if (PIN_SET.includes(args[0])) {
			profileName = currentProfile;
			pinValue = args[0];
		} else {
			ctx.ui.notify(`Unknown router profile: ${profileName}`, "error");
			return;
		}
	}

	if (!PIN_SET.includes(pinValue)) {
		ctx.ui.notify(
			`Invalid router pin: ${pinValue}. Use one of: ${ROUTER_PIN_VALUES.join(", ")}`,
			"error",
		);
		return;
	}

	const nextTier =
		pinValue === "auto" ? undefined : (pinValue as RouterTier);
	if (nextTier) {
		state.pinnedTierByProfile[profileName] = nextTier;
	} else {
		delete state.pinnedTierByProfile[profileName];
	}
	actions.persistState();
	actions.updateStatus(ctx);
	ctx.ui.notify(
		nextTier
			? `Router profile ${profileName} pinned to ${nextTier}`
			: `Router profile ${profileName} pin cleared; heuristic routing restored`,
		"info",
	);
};
