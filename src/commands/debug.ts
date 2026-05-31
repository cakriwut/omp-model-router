import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { Actions } from "./shared";
import { formatDecision } from "../ui";

export const handleDebug = (
	state: RouterState,
	actions: Actions,
) => async (args: string[], ctx: ExtensionContext) => {
	const cmd = args[0]?.toLowerCase();
	if (cmd === "on") state.debugEnabled = true;
	else if (cmd === "off") state.debugEnabled = false;
	else if (cmd === "clear") state.debugHistory.length = 0;
	else if (cmd === "show") {
		if (state.debugHistory.length === 0) {
			ctx.ui.notify("No recent routing decisions.", "info");
		} else {
			const history = state.debugHistory
				.map(
					(d) =>
						`[${new Date(d.timestamp).toLocaleTimeString()}] ${formatDecision(d)}`,
				)
				.join("\n");
			ctx.ui.notify(`Recent Routing Decisions:\n${history}`, "info");
		}
		return;
	} else {
		state.debugEnabled = !state.debugEnabled;
	}
	actions.persistState();
	ctx.ui.notify(
		`Router debug ${state.debugEnabled ? "enabled" : "disabled"}.`,
		"info",
	);
};
