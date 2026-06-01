import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";

export const handleEmbargo = (
	state: RouterState,
) => {
	return async (subArgs: string[], ctx: ExtensionContext) => {
		const action = subArgs[0]?.toLowerCase();

		if (action === "clear") {
			state.clearAllEmbargoes();
			ctx.ui.notify("✓ All embargoes cleared.", "info");
			return;
		}

		const active = state.getActiveEmbargoes();
		if (active.length === 0) {
			ctx.ui.notify("No active embargoes.", "info");
			return;
		}

		const now = Date.now();
		const lines = ["**Active Embargoes:**", ""];
		for (const entry of active) {
			const remaining = Math.ceil((entry.expiresAt - now) / 1000);
			const mins = Math.floor(remaining / 60);
			const secs = remaining % 60;
			const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
			lines.push(`⏸ **${entry.modelRef}**`);
			lines.push(`  Status: HTTP ${entry.status ?? "unknown"} | Remaining: ${timeStr}`);
			lines.push(`  Reason: ${entry.reason}`);
			if (entry.requestedDurationMs && entry.requestedDurationMs !== entry.effectiveDurationMs) {
				lines.push(`  Provider requested: ${Math.ceil(entry.requestedDurationMs / 1000)}s (capped to ${Math.ceil(entry.effectiveDurationMs / 1000)}s)`);
			}
			lines.push("");
		}
		lines.push("Use `/router embargo clear` to lift all embargoes.");
		ctx.ui.notify(lines.join("\n"), "info");
	};
};
