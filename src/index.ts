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
import { registerCommands } from "./commands/index.js";
import { registerRouterProvider } from "./provider";
import {
	onSessionStart as calibrationSessionStart,
	onSessionBranch as calibrationSessionBranch,
	onTurnStart as calibrationTurnStart,
	onTurnEnd as calibrationTurnEnd,
} from "./calibration/hooks";
import { checkForUpdate } from "./version-check";
import { registerRtkIntegration } from "./rtk-integration";
import { setScopedPin, clearScopedPin, clearSystemPin } from "./routing/pin";

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
				state.scope,
				state.thinkingByProfile,
				state.lastDecision,
				state.lastNonRouterModel,
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
			// Restore embargo state from disk
			state.restoreEmbargo();
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
	
	// Register RTK integration (state-aware for observability)
	registerRtkIntegration(pi, state);

	const resolveParentFromHeader = (ctx: ExtensionContext): string | undefined => {
		try {
			return ctx.sessionManager.getHeader()?.parentSession ?? undefined;
		} catch {
			return undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		// ── Phase 1 (synchronous): populate config + state before any await ─────
		// This ensures state.routerEnabled and state.currentModelRegistry are set
		// correctly before the 50ms propagation await, eliminating the race where
		// turn_start fires during that window and sees routerEnabled=false, causing
		// the first prompt to use the lastNonRouterModel instead of the router.
		actions.reloadConfig(); // loads config, calls registerRouterProvider() (no registry yet)

		// Activate session scope (isolates cost/state per session)
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionParent = resolveParentFromHeader(ctx);
		state.activateSession(sessionId, sessionParent, sessionParent ? "header" : "none");

		state.restoreFromSession(ctx); // sets currentModelRegistry and routerEnabled (authoritative)
		// Scoped pins are session-scoped and must not survive into a new conversation.
		// activateSession() only creates a fresh scope for brand-new session IDs; if
		// OMP reuses the same ID (e.g. reload within the same process), the existing
		// scope — including any rule/heuristic/classifier pin from a previous run —
		// would otherwise persist here. Clear it unconditionally on every session_start.
		clearScopedPin(state.scope);

		// Re-register provider now that currentModelRegistry is populated so model
		// definitions (contextWindow, maxTokens, reasoning) are correct.
		// The modelsKey guard ensures a no-op if nothing changed.
		actions.registerRouterProvider();

		// ── Phase 2 (async): wait for provider propagation, then switch model ───
		// Wait for registerProvider to propagate to the model registry.
		// The framework has no "provider registration complete" event; 50 ms
		// is empirical slack so ctx.modelRegistry.find("router", …) resolves.
		await new Promise((resolve) => setTimeout(resolve, 50));

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
				// ctx.ui.setHiddenThinkingLabel?.(); // API not available yet
			}
		} else {
			// ctx.ui.setHiddenThinkingLabel?.(); // API not available yet
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
		// ── Phase 1 (synchronous): populate config + state before any await ─────
		actions.reloadConfig();

		// Activate scope for the branched session
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionParent = resolveParentFromHeader(ctx);
		state.activateSession(sessionId, sessionParent, sessionParent ? "header" : "none");

		state.restoreFromSession(ctx); // sets currentModelRegistry and routerEnabled
		// On branch: clear rule/heuristic/classifier pins (stale phase inference);
		// preserve user-set pins since those represent explicit user intent.
		clearSystemPin(state.scope);

		// Re-register with correct registry data.
		actions.registerRouterProvider();

		// ── Phase 2 (async): wait for provider propagation, then switch model ───
		await new Promise((resolve) => setTimeout(resolve, 50));

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
				// ctx.ui.setHiddenThinkingLabel?.(); // API not available yet
			}
		} else {
			// ctx.ui.setHiddenThinkingLabel?.(); // API not available yet
		}

		state.persist();
		actions.updateStatus(ctx);

		// Clone calibration state for branch
		await calibrationSessionBranch(_event, ctx, state, state.currentConfig);
	});

	pi.on("turn_start", async (_event, ctx) => {
		// Re-activate the correct session scope (handles sub-agent context switches)
		const sessionId = ctx.sessionManager.getSessionId();
		if (sessionId !== state.activeSessionId) {
			const headerParent = resolveParentFromHeader(ctx);
			const fallbackParent = state.activeSessionId;
			const resolvedParent = headerParent ?? fallbackParent;
			const source = headerParent ? "header" : (fallbackParent ? "fallback" : "none");

			if (
				state.currentConfig.debug &&
				headerParent !== undefined &&
				fallbackParent !== undefined &&
				headerParent !== fallbackParent
			) {
				console.log(
					`[model-router] parent attribution disagreement for ${sessionId}: header=${headerParent} fallback=${fallbackParent} — using header`
				);
			}

			state.activateSession(sessionId, resolvedParent, source);
		}

		// Store ctx so provider.ts can resolve getArtifactsDir() for prompt logging.
		// Cleared in turn_end via state.clearSessionContext(endSessionId).
		state.setSessionContext(sessionId, ctx);

		// Increment userMessagesSeen when a new user-role message arrives.
		// Checked via session entry id (survives message count can decrease).
		try {
			const branch = ctx.sessionManager.getBranch();
			// Walk from the end; find the most recent user-role message entry
			for (let i = branch.length - 1; i >= 0; i--) {
				const e = branch[i];
				if (e.type === "message" && (e as any).message?.role === "user") {
					if (e.id !== state.scope.lastUserEntryId) {
						state.scope.userMessagesSeen += 1;
						state.scope.lastUserEntryId = e.id;
					}
					break;
				}
			}
		} catch {
			// If branch is unavailable, skip — userMessagesSeen stays at previous value
		}

		if (state.updateBannerShown) {
			state.updateBannerShown = false;
		}

		// Honor user-initiated model switches: if router is marked enabled but the
		// active model is no longer "router", the user changed it via /model. Treat
		// it as an opt-out — disable router so we don't force-restore it on turn_end.
		if (
			state.routerEnabled &&
			!state.isInternalModelSwitch &&
			ctx.model &&
			ctx.model.provider !== "router"
		) {
			state.routerEnabled = false;
			state.lastNonRouterModel = `${ctx.model.provider}/${ctx.model.id}`;
			patchConfigFile({ routerEnabled: false });
			state.persist();
			// ctx.ui.setHiddenThinkingLabel?.(); // API not available yet
			actions.updateStatus(ctx);
		}

		if (state.routerEnabled) {
			state.isStreaming = true;
			actions.updateStatus(ctx);
		}

		// Poll pending classifier, timeout stale agents
		await calibrationTurnStart(_event, ctx, state, state.currentConfig);
	});

	pi.on("turn_end", async (_event, ctx) => {
		const endSessionId = ctx.sessionManager.getSessionId();
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

		// Release the context reference — it holds the full session tree (messages,
		// sessionManager, modelRegistry). Keeping it past turn_end prevents GC of the
		// prior turn's message set.
		state.clearSessionContext(endSessionId);
	});

	// session_end is not a standard extension event; instead merge calibration
	// on turn_end when the session is about to close. The global merge also
	// happens via debounced writes during the session, so data is not lost.

	// ─── Agent end: finalize child session and merge cost to parent ────────────
	pi.on("agent_end", (_event, ctx) => {
		const sessionId = ctx.sessionManager.getSessionId();
		// If this session is a child (has a parent), merge its cost upward
		state.finalizeChildSession(sessionId);
	});

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
				setScopedPin(state.scope, upgradedTier, "auto-upgrade", state.currentConfig);
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
