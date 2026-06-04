import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { Actions } from "./shared";
import { profileNames, resolveProfileName } from "../config";
import { formatThinkingSummary, formatModelRef } from "../ui";
import { getCurrentVersion } from "../version-check";
import { DEFAULT_PIN_TIMEOUT_MS } from "../routing/pin";

/** Format scoped pin status for display. */
const formatScopedPin = (state: RouterState): string => {
	const pin = state.scope.scopedPin;
	if (!pin) {
		const floor = state.currentConfig.defaultPin ?? "auto";
		return floor === "auto" ? "none (heuristic free)" : `none (default: ${floor})`;
	}
	const timeout = state.currentConfig.pinTimeout ?? DEFAULT_PIN_TIMEOUT_MS;
	const remaining = timeout - (Date.now() - pin.setAt);
	if (remaining <= 0) return "expired";
	const secs = Math.ceil(remaining / 1000);
	const ttl = secs >= 60 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${secs}s`;
	return `${pin.tier} [${pin.source}] (expires in ${ttl})`;
};

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
		`Scoped pin: ${formatScopedPin(state)}`,
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
		`History compression: ${state.currentConfig.historyCompression?.enabled ? `on (keepLastN: ${state.currentConfig.historyCompression.keepLastN ?? 4})` : "off"}`,
	];
	if (state.lastDecision) {
		lines.push(
			`Last routed tier: ${state.lastDecision.tier}`,
			`Last phase: ${state.lastDecision.phase}`,
			`Last model: ${state.lastDecision.targetProvider}/${state.lastDecision.targetModelId} (${state.lastDecision.thinking})`,
			`Reason: ${state.lastDecision.reasoning}`,
		);
	}
	ctx.ui.notify(lines.join("\n"), "info");
	actions.updateStatus(ctx);
};
