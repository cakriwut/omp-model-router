import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import {
	loadRouterConfig,
	patchConfigFile,
	profileNames,
	ROUTER_TIERS,
	resolveProfileName,
} from "./config";
import { RouterState } from "./state";
import { updateStatus } from "./ui";
import { registerCommands } from "./commands";
import { registerRouterProvider } from "./provider";
import {
	onSessionStart as calibrationSessionStart,
	onSessionBranch as calibrationSessionBranch,
	onTurnStart as calibrationTurnStart,
	onTurnEnd as calibrationTurnEnd,
} from "./calibration/hooks";
import { checkForUpdate } from "./version-check";

const routerExtension = (pi: ExtensionAPI) => {
	pi.setLabel("Model Router");

	const state = new RouterState(pi);

	const setModelInternally = async (
		model: NonNullable<ExtensionContext["model"]>,
	) => {
		state.isInternalModelSwitch = true;
		try {
			return await pi.setModel(model);
		} finally {
			state.isInternalModelSwitch = false;
		}
	};

	const actions = {
		setModelInternally,
		persistState: () => state.persist(),
		updateStatus: (ctx: ExtensionContext) =>
			updateStatus(
				ctx,
				state.routerEnabled,
				state.selectedProfile,
				state.pinnedTierByProfile,
				state.thinkingByProfile,
				state.lastDecision,
				state.lastNonRouterModel,
				state.accumulatedCost,
				state.widgetEnabled,
				state.currentConfig,
				state.isStreaming,
			),
		reloadConfig: (
			ctx?: ExtensionContext,
			options?: { preserveDebug?: boolean },
		) => {
			const loaded = loadRouterConfig(state.currentCwd);
			state.currentConfig = loaded.config;
			if (!options?.preserveDebug) {
				state.debugEnabled = state.currentConfig.debug ?? false;
			}
			state.selectedProfile = resolveProfileName(
				state.currentConfig,
				state.selectedProfile,
			);
			actions.registerRouterProvider();
			// Initialize calibration if newly enabled (handles /reload after enabling in config)
			if (ctx && state.currentConfig.calibration?.enabled && !state.calibration) {
				calibrationSessionStart(undefined, ctx, state, state.currentConfig).catch(() => {});
			}
			if (ctx) {
				actions.updateStatus(ctx);
			}
		},
		ensureValidActiveRouterProfile: async (ctx: ExtensionContext) => {
			// Only act if the framework already has a router model active
			if (ctx.model?.provider !== "router") {
				return;
			}
			// If the config-selected profile still exists, nothing to do
			if (state.currentConfig.profiles[state.selectedProfile]) {
				return;
			}
			// The selected profile was removed from config — fall back
			const fallbackProfile = resolveProfileName(
				state.currentConfig,
				state.selectedProfile,
			);
			const routerModel = ctx.modelRegistry.find("router", fallbackProfile);
			state.selectedProfile = fallbackProfile;
			if (!routerModel) {
				ctx.ui.notify(
					`Router profile "${state.selectedProfile}" is no longer configured.`,
					"warning",
				);
				return;
			}

			await setModelInternally(routerModel);
			ctx.ui.notify(
				`Router profile was removed from config. Switched to router/${fallbackProfile}.`,
				"warning",
			);
		},
		switchToRouterProfile: async (
			profileName: string,
			ctx: ExtensionContext,
			strict = true,
		) => {
			if (strict && !state.currentConfig.profiles[profileName]) {
				ctx.ui.notify(`Unknown router profile: ${profileName}`, "error");
				return false;
			}
			const resolvedProfile = resolveProfileName(
				state.currentConfig,
				profileName,
			);

			actions.registerRouterProvider();
			// Wait for registerProvider to propagate to the model registry.
			// The framework has no "provider registration complete" event; 50 ms
			// is empirical slack so ctx.modelRegistry.find("router", …) resolves.
			await new Promise((resolve) => setTimeout(resolve, 50));

			const routerModel = ctx.modelRegistry.find("router", resolvedProfile);
			if (!routerModel) {
				ctx.ui.notify(`Unknown router profile: ${profileName}`, "error");
				return false;
			}
			if (ctx.model && ctx.model.provider !== "router") {
				state.lastNonRouterModel = `${ctx.model.provider}/${ctx.model.id}`;
			}
			const success = await setModelInternally(routerModel);
			if (!success) {
				ctx.ui.notify(
					`Failed to switch to router/${resolvedProfile}`,
					"error",
				);
				return false;
			}
			state.selectedProfile = resolvedProfile;
			state.routerEnabled = true;
			patchConfigFile({ routerEnabled: true, defaultProfile: resolvedProfile });
			state.persist();
			actions.updateStatus(ctx);
			return true;
		},
		registerRouterProvider: () => {
			registerRouterProvider(pi, state, {
				persistState: () => state.persist(),
				recordDebugDecision: (d) => state.recordDecision(d),
				getThinkingOverride: (profileName, tier) =>
					state.getThinkingOverride(profileName, tier),
				updateStatus: actions.updateStatus,
			});
		},
	};

	actions.reloadConfig();

	registerCommands(pi, state, actions);

	pi.on("session_start", async (_event, ctx) => {
		actions.reloadConfig();

		// Wait for registerProvider to propagate (see switchToRouterProfile comment).
		await new Promise((resolve) => setTimeout(resolve, 50));

		state.restoreFromSession(ctx);

		await actions.ensureValidActiveRouterProfile(ctx);

		if (state.routerEnabled) {
			const routerModel = ctx.modelRegistry.find(
				"router",
				state.selectedProfile,
			);
			if (routerModel) {
				const success = await setModelInternally(routerModel);
				if (!success) {
					ctx.ui.notify(
						`Failed to restore router/${state.selectedProfile} after relaunch.`,
						"warning",
					);
					state.routerEnabled = false;
				}
			} else {
				ctx.ui.notify(
					`Unable to restore router/${state.selectedProfile}; model is unavailable.`,
					"warning",
				);
				state.routerEnabled = false;
				ctx.ui.setHiddenThinkingLabel?.();
			}
		} else {
			ctx.ui.setHiddenThinkingLabel?.();
		}

		state.persist();
		actions.updateStatus(ctx);

		if (state.debugEnabled) {
			ctx.ui.notify(
				`Router initialized with profiles: ${profileNames(state.currentConfig).join(", ")}`,
				"info",
			);
		}

		// Fire-and-forget update detection (non-blocking)
		checkForUpdate().then((info) => {
			if (info) {
				state.updateAvailable = { current: info.current, latest: info.latest };
				state.updateBannerShown = true;
				ctx.ui.notify(
					`🆙 Model Router v${info.current} → v${info.latest} available — run /router update`,
					"info",
				);
			}
		});

		// Initialize calibration (telemetry mode)
		await calibrationSessionStart(_event, ctx, state, state.currentConfig);
	});

	pi.on("session_branch", async (_event, ctx) => {
		actions.reloadConfig();

		await new Promise((resolve) => setTimeout(resolve, 50));

		state.restoreFromSession(ctx);

		await actions.ensureValidActiveRouterProfile(ctx);

		if (state.routerEnabled) {
			const routerModel = ctx.modelRegistry.find(
				"router",
				state.selectedProfile,
			);
			if (routerModel) {
				const success = await setModelInternally(routerModel);
				if (!success) {
					ctx.ui.notify(
						`Failed to restore router/${state.selectedProfile} after relaunch.`,
						"warning",
					);
					state.routerEnabled = false;
				}
			} else {
				ctx.ui.notify(
					`Unable to restore router/${state.selectedProfile}; model is unavailable.`,
					"warning",
				);
				state.routerEnabled = false;
				ctx.ui.setHiddenThinkingLabel?.();
			}
		} else {
			ctx.ui.setHiddenThinkingLabel?.();
		}

		state.persist();
		actions.updateStatus(ctx);

		// Clone calibration state for branch
		await calibrationSessionBranch(_event, ctx, state, state.currentConfig);
	});

	pi.on("turn_start", async (_event, ctx) => {
		state.lastExtensionContext = ctx;
		if (state.updateBannerShown) {
			state.updateBannerShown = false;
		}
		if (state.routerEnabled) {
			state.isStreaming = true;
			actions.updateStatus(ctx);
		}

		// Poll pending classifier, timeout stale agents
		await calibrationTurnStart(_event, ctx, state, state.currentConfig);
	});

	pi.on("turn_end", async (_event, ctx) => {
		state.lastExtensionContext = ctx;
		state.isStreaming = false;
		if (state.routerEnabled && ctx.model?.provider !== "router") {
			const routerModel = ctx.modelRegistry.find(
				"router",
				state.selectedProfile,
			);
			if (routerModel) {
				await setModelInternally(routerModel);
			}
		}
		state.persist();
		actions.updateStatus(ctx);

		// Poll classifier (first chance), write trace
		await calibrationTurnEnd(_event, ctx, state, state.currentConfig);
	});

	// session_end is not a standard extension event; instead merge calibration
	// on turn_end when the session is about to close. The global merge also
	// happens via debounced writes during the session, so data is not lost.

	// ─── Auto-upgrade: track consecutive tool failures ─────────────────────────
	pi.on("tool_execution_end", (event, ctx) => {
		if (!state.routerEnabled) return;
		const cfg = state.currentConfig.autoUpgrade;
		if (!cfg?.enabled) return;

		const threshold = cfg.threshold ?? 2;

		if (!event.isError) {
			// Success resets the streak for this tool
			state.toolFailureStreak.delete(event.toolName);
			return;
		}

		// If tools filter is set, only track those tools
		if (cfg.tools && !cfg.tools.includes(event.toolName)) return;

		const prev = state.toolFailureStreak.get(event.toolName) ?? 0;
		const streak = prev + 1;
		state.toolFailureStreak.set(event.toolName, streak);

		if (streak >= threshold) {
			// Determine upgrade: current tier → next higher tier
			const currentTier = state.lastDecision?.tier ?? "low";
			const currentIdx = ROUTER_TIERS.indexOf(currentTier);
			if (currentIdx > 0) {
				const upgradedTier = ROUTER_TIERS[currentIdx - 1]; // higher = lower index
				state.autoUpgradeTier = upgradedTier;
				state.toolFailureStreak.delete(event.toolName);
				if (state.debugEnabled) {
					ctx.ui.notify(
						`Auto-upgrade: ${event.toolName} failed ${streak}× → upgrading to ${upgradedTier} tier`,
						"info",
					);
				}
			}
		}
	});
};

export default routerExtension;
