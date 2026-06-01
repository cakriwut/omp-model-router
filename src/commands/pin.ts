import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { RouterTier } from "../types";
import type { Actions } from "./shared";
import { ROUTER_PIN_VALUES } from "../config";
import { setScopedPin, clearScopedPin, DEFAULT_PIN_TIMEOUT_MS } from "../routing/pin";

const PIN_SET = ROUTER_PIN_VALUES as readonly string[];

/** Format time-remaining in seconds as a human-readable string. */
const formatTTL = (remainingMs: number): string => {
	const secs = Math.ceil(remainingMs / 1000);
	if (secs >= 60) {
		const mins = Math.floor(secs / 60);
		const s = secs % 60;
		return s > 0 ? `${mins}m ${s}s` : `${mins}m`;
	}
	return `${secs}s`;
};

export const handlePin = (
	state: RouterState,
	actions: Actions,
) => async (args: string[], ctx: ExtensionContext) => {
	const currentProfile = state.selectedProfile;
	if (args.length === 0) {
		const pin = state.scope.scopedPin;
		const timeout = state.currentConfig.pinTimeout ?? DEFAULT_PIN_TIMEOUT_MS;
		let pinLine: string;
		if (pin) {
			const remaining = timeout - (Date.now() - pin.setAt);
			const ttl = remaining > 0 ? ` (expires in ${formatTTL(remaining)})` : " (expired)";
			const pressureThreshold = state.currentConfig.pinPressureThreshold ?? 3;
			const pressureCount = pin.overridePressureCount ?? 0;
			const pressureSuffix =
				pin.source !== "user" && pressureCount > 0
					? ` [pressure: ${pressureCount}/${pressureThreshold}]`
					: "";
			pinLine = `Scoped pin: ${pin.tier} [source: ${pin.source}]${pressureSuffix}${ttl}`;
		} else {
			const floor = state.currentConfig.defaultPin ?? "auto";
			pinLine = `Scoped pin: none (floor: ${floor})`;
		}
		ctx.ui.notify(
			[
				`Profile: ${currentProfile}`,
				pinLine,
				`Usage: /router pin <high|medium|low|auto>`,
			].join("\n"),
			"info",
		);
		actions.updateStatus(ctx);
		return;
	}

	// Only support single arg now (profile-scoped pins removed in favour of session-scoped)
	let pinValue = "";

	if (args.length === 1) {
		pinValue = args[0];
	} else {
		// Legacy two-arg form: /router pin <profile> <tier>
		// Silently treat second arg as the pin value if it looks like a tier/auto.
		const maybeProfile = args[0];
		const maybeTier = args[1];
		if (PIN_SET.includes(maybeTier)) {
			// Warn about the profile arg being ignored
			ctx.ui.notify(
				`Note: session-scoped pins are profile-independent. Profile arg "${maybeProfile}" ignored.`,
				"info",
			);
			pinValue = maybeTier;
		} else if (PIN_SET.includes(maybeProfile)) {
			pinValue = maybeProfile;
		} else {
			ctx.ui.notify(
				`Invalid arguments. Usage: /router pin <high|medium|low|auto>`,
				"error",
			);
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

	if (pinValue === "auto") {
		// Manual decay: clear pin and lastDecision for a fresh start
		clearScopedPin(state.scope);
		actions.persistState();
		actions.updateStatus(ctx);
		ctx.ui.notify(
			`Pin cleared; heuristic routing restored (lastDecision reset).`,
			"info",
		);
		return;
	}

	const nextTier = pinValue as RouterTier;
	setScopedPin(state.scope, nextTier, "user", state.currentConfig);
	actions.persistState();
	actions.updateStatus(ctx);
	ctx.ui.notify(
		`Router pinned to ${nextTier} (session-scoped, decays in ${formatTTL(state.currentConfig.pinTimeout ?? DEFAULT_PIN_TIMEOUT_MS)})`,
		"info",
	);
};
