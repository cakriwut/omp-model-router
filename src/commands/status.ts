import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { Actions } from "./shared";
import { profileNames, resolveProfileName } from "../config";
import { formatThinkingSummary, formatModelRef, formatScopedPin, shortenModelRef } from "../ui";
import { getCurrentVersion } from "../version-check";

export const handleStatus = (
	state: RouterState,
	actions: Actions,
) => async (_args: string[], ctx: ExtensionContext) => {
	const names = profileNames(state.currentConfig).join(", ");
	const currentVersion = getCurrentVersion();
	const updateLine = state.updateAvailable
		? `Version: v${currentVersion} (v${state.updateAvailable.latest} available — run /router update)`
		: `Version: v${currentVersion}`;
	const lines = [
		"Model Router Status:",
		updateLine,
		`Router enabled: ${state.routerEnabled ? "yes" : "off"}`,
		`Selected profile: ${state.selectedProfile}`,
		`Scoped pin: ${formatScopedPin(state.scope, state.currentConfig)}`,
		`Thinking overrides: ${formatThinkingSummary(state.thinkingByProfile)}`,
		`Widget: ${state.widgetEnabled ? "on" : "off"}`,
		`Phase bias: ${state.currentConfig.phaseBias}`,
		`Session cost: $${state.accumulatedCost.toFixed(4)}` +
			(state.currentConfig.maxSessionBudget
				? ` / $${state.currentConfig.maxSessionBudget.toFixed(2)}`
				: ""),
		`Default profile: ${resolveProfileName(state.currentConfig, state.currentConfig.defaultProfile)}`,
		`Available profiles: ${names}`,
		`Last non-router model: ${formatModelRef(state.lastNonRouterModel)}`,
		`Debug: ${state.debugEnabled ? "on" : "off"}`,
		`Debug history: ${state.debugHistory.length} decisions`,
	];
	if (state.lastDecision && state.lastDecision.profile === state.selectedProfile) {
		const u = state.lastDecision.usage;
		const usageStr = u
			? `↑${u.inputTokens.toLocaleString()} ↓${u.outputTokens.toLocaleString()}` +
			  (u.cacheReadTokens > 0 ? ` 📦${u.cacheReadTokens.toLocaleString()}` : "") +
			  ` $${(u.cost ?? 0).toFixed(4)}`
			: "—";
		lines.push(
			`Route: ${state.lastDecision.tier} → ${state.lastDecision.targetProvider}/${state.lastDecision.targetModelId} (${state.lastDecision.thinking})`,
		);
		if (state.lastDecision.classifierModelRef) {
			lines.push(`Classifier: ${shortenModelRef(state.lastDecision.classifierModelRef)}`);
		}
		lines.push(
			`Phase: ${state.lastDecision.phase}`,
			`Usage: ${usageStr}`,
			`Reason: ${state.lastDecision.reasoning}`,
		);
	}
	ctx.ui.notify(lines.join("\n"), "info");
	actions.updateStatus(ctx);
};
