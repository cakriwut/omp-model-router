import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { Actions } from "./shared";

export const handleWidget = (
	state: RouterState,
	actions: Actions,
) => async (args: string[], ctx: ExtensionContext) => {
	const cmd = args[0]?.toLowerCase();
	if (cmd === "on") state.widgetEnabled = true;
	else if (cmd === "off") state.widgetEnabled = false;
	else state.widgetEnabled = !state.widgetEnabled;
	actions.persistState();
	actions.updateStatus(ctx);
	ctx.ui.notify(
		`Router widget ${state.widgetEnabled ? "enabled" : "disabled"}.`,
		"info",
	);
};
