import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type {
	RouterConfig,
	RouterPinByProfile,
	RouterThinkingByProfile,
	RoutingDecision,
	RouterTier,
} from "./types";
import {
	profileNames,
	resolveProfileName,
	THINKING_LEVELS,
	ROUTER_PIN_VALUES,
	ROUTER_TIERS,
	parseCanonicalModelRef,
} from "./config";
import {
	formatPinSummary,
	formatThinkingSummary,
	formatModelRef,
	formatDecision,
} from "./ui";

export const registerCommands = (
	pi: ExtensionAPI,
	state: {
		readonly currentConfig: RouterConfig;
		routerEnabled: boolean;
		selectedProfile: string;
		readonly pinnedTierByProfile: RouterPinByProfile;
		readonly thinkingByProfile: RouterThinkingByProfile;
		readonly lastDecision: RoutingDecision | undefined;
		lastNonRouterModel: string | undefined;
		readonly accumulatedCost: number;
		debugEnabled: boolean;
		widgetEnabled: boolean;
		readonly debugHistory: RoutingDecision[];
	},
	actions: {
		persistState: () => void;
		updateStatus: (ctx: ExtensionContext) => void;
		reloadConfig: (
			ctx?: ExtensionContext,
			options?: { preserveDebug?: boolean },
		) => void;
		ensureValidActiveRouterProfile: (ctx: ExtensionContext) => Promise<void>;
		switchToRouterProfile: (
			profileName: string,
			ctx: ExtensionContext,
			strict?: boolean,
		) => Promise<boolean>;
	},
) => {
	const handleStatus = async (_args: string[], ctx: ExtensionContext) => {
		const names = profileNames(state.currentConfig).join(", ");
		const lines = [
			"Model Router Status:",
			`Router enabled: ${state.routerEnabled ? "yes" : "off"}`,
			`Selected profile: ${state.selectedProfile}`,
			`Selected profile pin: ${state.pinnedTierByProfile[state.selectedProfile] ?? "auto"}`,
			`Pins by profile: ${formatPinSummary(state.pinnedTierByProfile)}`,
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

	const handleProfile = async (args: string[], ctx: ExtensionContext) => {
		const profileName = args[0];
		if (!profileName) {
			ctx.ui.notify(
				`Current profile: ${state.selectedProfile}. Available: ${profileNames(state.currentConfig).join(", ")}`,
				"info",
			);
			return;
		}
		const success = await actions.switchToRouterProfile(profileName, ctx);
		if (success) {
			ctx.ui.notify(
				`Switched to router profile: ${state.selectedProfile}`,
				"info",
			);
		}
	};

	const handlePin = async (args: string[], ctx: ExtensionContext) => {
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
			if (ROUTER_PIN_VALUES.includes(args[0] as any)) {
				profileName = currentProfile;
				pinValue = args[0];
			} else {
				ctx.ui.notify(`Unknown router profile: ${profileName}`, "error");
				return;
			}
		}

		if (!ROUTER_PIN_VALUES.includes(pinValue as any)) {
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

	const handleThinking = async (args: string[], ctx: ExtensionContext) => {
		const currentProfile = state.selectedProfile;
		if (args.length === 0) {
			ctx.ui.notify(
				[
					`Profile: ${currentProfile}`,
					`Thinking overrides: ${JSON.stringify(state.thinkingByProfile[currentProfile] ?? {})}`,
					"Usage: /router thinking <level|auto>",
					"   or: /router thinking <tier> <level|auto>",
					"   or: /router thinking <profile> <tier> <level|auto>",
				].join("\n"),
				"info",
			);
			return;
		}

		let profileName = currentProfile;
		let tier: RouterTier | "all" | undefined = undefined;
		let levelValue = "";

		const tierValues = ["high", "medium", "low"];
		const levelValues = ["auto", ...THINKING_LEVELS];

		if (args.length === 1) {
			levelValue = args[0];
			tier =
				state.pinnedTierByProfile[profileName] ??
				(state.lastDecision?.profile === profileName
					? state.lastDecision.tier
					: "medium");
		} else if (args.length === 2) {
			if (tierValues.includes(args[0]) || args[0] === "all") {
				tier = args[0] as RouterTier | "all";
				levelValue = args[1];
			} else {
				profileName = args[0];
				levelValue = args[1];
				tier =
					state.pinnedTierByProfile[profileName] ??
					(state.lastDecision?.profile === profileName
						? state.lastDecision.tier
						: "medium");
			}
		} else if (args.length === 3) {
			profileName = args[0];
			tier = args[1] as RouterTier | "all";
			levelValue = args[2];
		}

		if (!state.currentConfig.profiles[profileName]) {
			ctx.ui.notify(`Unknown router profile: ${profileName}`, "error");
			return;
		}
		if (tier !== "all" && !tierValues.includes(tier as string)) {
			ctx.ui.notify(
				`Invalid tier: ${tier}. Use high, medium, or low.`,
				"error",
			);
			return;
		}
		if (!levelValues.includes(levelValue)) {
			ctx.ui.notify(
				`Invalid thinking level: ${levelValue}. Use auto or: ${THINKING_LEVELS.join(", ")}`,
				"error",
			);
			return;
		}

		const nextLevel =
			levelValue === "auto" ? undefined : (levelValue as any);
		if (tier === "all") {
			for (const t of ROUTER_TIERS) {
				if (!state.thinkingByProfile[profileName])
					state.thinkingByProfile[profileName] = {};
				if (nextLevel) state.thinkingByProfile[profileName]![t] = nextLevel;
				else delete state.thinkingByProfile[profileName]![t];
			}
		} else {
			if (!state.thinkingByProfile[profileName])
				state.thinkingByProfile[profileName] = {};
			if (nextLevel)
				state.thinkingByProfile[profileName]![tier as RouterTier] = nextLevel;
			else delete state.thinkingByProfile[profileName]![tier as RouterTier];
		}
		if (
			state.thinkingByProfile[profileName] &&
			Object.keys(state.thinkingByProfile[profileName]!).length === 0
		) {
			delete state.thinkingByProfile[profileName];
		}

		actions.persistState();
		actions.updateStatus(ctx);
		ctx.ui.notify(
			nextLevel
				? `Router profile ${profileName} thinking (${tier}) set to ${nextLevel}`
				: `Router profile ${profileName} thinking (${tier}) reset to config defaults`,
			"info",
		);
	};

	const handleDisable = async (_args: string[], ctx: ExtensionContext) => {
		if (!state.lastNonRouterModel) {
			ctx.ui.notify(
				"No previous non-router model recorded. Use /model to pick a concrete model.",
				"warning",
			);
			return;
		}
		const { provider, modelId } = parseCanonicalModelRef(
			state.lastNonRouterModel,
		);
		const targetModel = ctx.modelRegistry.find(provider, modelId);
		if (!targetModel) {
			ctx.ui.notify(
				`Recorded non-router model is unavailable: ${state.lastNonRouterModel}`,
				"error",
			);
			return;
		}
		const success = await pi.setModel(targetModel);
		if (!success) {
			ctx.ui.notify(
				`Failed to switch to ${state.lastNonRouterModel}`,
				"error",
			);
			return;
		}
		state.routerEnabled = false;
		actions.persistState();
		actions.updateStatus(ctx);
		ctx.ui.notify(
			`Router disabled. Restored ${state.lastNonRouterModel}`,
			"info",
		);
	};

	const handleFix = async (args: string[], ctx: ExtensionContext) => {
		if (args.length !== 1) {
			ctx.ui.notify("Usage: /router fix <high|medium|low>", "error");
			return;
		}
		const tier = args[0]?.toLowerCase();
		if (!ROUTER_TIERS.includes(tier as RouterTier)) {
			ctx.ui.notify("Usage: /router fix <high|medium|low>", "error");
			return;
		}
		if (!state.lastDecision) {
			ctx.ui.notify("No recent routing decision to fix.", "warning");
			return;
		}
		state.pinnedTierByProfile[state.lastDecision.profile] =
			tier as RouterTier;
		actions.persistState();
		actions.updateStatus(ctx);
		ctx.ui.notify(
			`Router decision corrected. ${state.lastDecision.profile} is now pinned to ${tier}.`,
			"info",
		);
	};

	const handleWidget = async (args: string[], ctx: ExtensionContext) => {
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

	const handleDebug = async (args: string[], ctx: ExtensionContext) => {
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

	const handleUsage = async (_args: string[], ctx: ExtensionContext) => {
		const profile = state.currentConfig.profiles[state.selectedProfile];
		if (!profile) {
			ctx.ui.notify("No active router profile.", "error");
			return;
		}

		// Gather per-model usage from debug history
		const modelUsage: Record<
			string,
			{ count: number; tier: string }
		> = {};
		for (const decision of state.debugHistory) {
			if (decision.profile !== state.selectedProfile) continue;
			const key = decision.targetLabel;
			if (!modelUsage[key]) {
				modelUsage[key] = { count: 0, tier: decision.tier };
			}
			modelUsage[key].count++;
		}

		// Build profile model table
		const tiers = ROUTER_TIERS;
		const profileLines: string[] = [];
		for (const tier of tiers) {
			const tierConfig = profile[tier];
			const { provider, modelId } = parseCanonicalModelRef(tierConfig.model);
			const registeredModel = ctx.modelRegistry.find(provider, modelId);
			const ctxWindow = registeredModel?.contextWindow ?? "?";
			const maxTok = registeredModel?.maxTokens ?? "?";
			const reasoning = registeredModel?.reasoning ? "✓" : "✗";
			const costInfo = registeredModel?.cost;
			const costStr = costInfo
				? `$${costInfo.input}/in $${costInfo.output}/out`
				: "n/a";
			const usageCount = modelUsage[tierConfig.model]?.count ?? 0;

			profileLines.push(
				`  ${tier.toUpperCase().padEnd(7)} ${modelId.padEnd(45)} ctx:${String(ctxWindow).padEnd(8)} max:${String(maxTok).padEnd(6)} reason:${reasoning} cost:${costStr} used:${usageCount}x`,
			);

			if (tierConfig.fallbacks?.length) {
				for (const fb of tierConfig.fallbacks) {
					const { provider: fbProv, modelId: fbId } =
						parseCanonicalModelRef(fb);
					const fbModel = ctx.modelRegistry.find(fbProv, fbId);
					const fbCtx = fbModel?.contextWindow ?? "?";
					const fbCost = fbModel?.cost;
					const fbCostStr = fbCost
						? `$${fbCost.input}/in $${fbCost.output}/out`
						: "n/a";
					const fbUsage = modelUsage[fb]?.count ?? 0;
					profileLines.push(
						`    └─fb ${fbId.padEnd(43)} ctx:${String(fbCtx).padEnd(8)} cost:${fbCostStr} used:${fbUsage}x`,
					);
				}
			}
		}

		// Tier distribution from history
		const tierCounts = { high: 0, medium: 0, low: 0 };
		for (const decision of state.debugHistory) {
			if (decision.profile !== state.selectedProfile) continue;
			if (decision.tier in tierCounts) {
				tierCounts[decision.tier as keyof typeof tierCounts]++;
			}
		}
		const totalDecisions = tierCounts.high + tierCounts.medium + tierCounts.low;

		// Context usage
		let contextLine = "";
		try {
			const usage = await ctx.getContextUsage();
			if (usage?.tokens) {
				const threshold = state.currentConfig.largeContextThreshold ?? 150000;
				const pct = ((usage.tokens / threshold) * 100).toFixed(0);
				contextLine = `Context: ${usage.tokens.toLocaleString()} tokens (${pct}% of ${threshold.toLocaleString()} threshold)`;
			}
		} catch {
			// ignore
		}

		// Budget
		const budget = state.currentConfig.maxSessionBudget;
		const budgetLine = budget
			? `Budget: $${state.accumulatedCost.toFixed(4)} / $${budget.toFixed(2)} (${((state.accumulatedCost / budget) * 100).toFixed(1)}% used)`
			: `Session cost: $${state.accumulatedCost.toFixed(4)}`;
		const budgetExceeded =
			budget !== undefined && state.accumulatedCost >= budget;

		// Assemble output
		const lines = [
			`═══ Router Usage: ${state.selectedProfile} ═══`,
			"",
			"Models:",
			...profileLines,
			"",
			`Tier distribution (${totalDecisions} decisions):`,
			`  high: ${tierCounts.high}x  medium: ${tierCounts.medium}x  low: ${tierCounts.low}x`,
			"",
			budgetLine + (budgetExceeded ? " ⚠️ EXCEEDED" : ""),
		];
		if (contextLine) lines.push(contextLine);
		if (state.lastDecision) {
			lines.push(
				"",
				`Last: ${state.lastDecision.tier} → ${state.lastDecision.targetProvider}/${state.lastDecision.targetModelId} (${state.lastDecision.thinking})`,
			);
		}

		ctx.ui.notify(lines.join("\n"), "info");
	};

	const handleReload = async (_args: string[], ctx: ExtensionContext) => {
		actions.reloadConfig(ctx, { preserveDebug: true });
		await actions.ensureValidActiveRouterProfile(ctx);
		ctx.ui.notify(
			`Router config reloaded. Profiles: ${profileNames(state.currentConfig).join(", ")}`,
			"info",
		);
	};

	pi.registerCommand("router", {
		description: "Model router control center",
		getArgumentCompletions: (prefix) => {
			const trimmedLeft = prefix.trimStart();
			const hasTrailingSpace = /\s$/.test(prefix);
			const parts =
				trimmedLeft.length > 0 ? trimmedLeft.split(/\s+/) : [];

		const SUBCOMMANDS = [
				"status",
				"usage",
				"profile",
				"pin",
				"thinking",
				"disable",
				"fix",
				"widget",
				"debug",
				"reload",
				"help",
			];

			if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
				const token = parts[0] ?? "";
				const items = SUBCOMMANDS.filter((s) => s.startsWith(token)).map(
					(s) => ({ value: s, label: s }),
				);
				return items.length > 0 ? items : null;
			}

			const subcommand = parts[0];
			const subArgs = parts.slice(1);
			if (hasTrailingSpace && parts.length === 1) subArgs.push("");

			switch (subcommand) {
				case "profile": {
					const profilePrefix = subArgs[0] ?? "";
					const items = profileNames(state.currentConfig)
						.filter((name) => name.startsWith(profilePrefix))
						.map((name) => ({
							value: `profile ${name}`,
							label: `router/${name}`,
						}));
					return items.length > 0 ? items : null;
				}
				case "pin": {
					const pinPrefix = subArgs[0] ?? "";
					const items = ROUTER_PIN_VALUES.filter((v) =>
						v.startsWith(pinPrefix),
					).map((v) => ({ value: `pin ${v}`, label: v }));
					return items.length > 0 ? items : null;
				}
				case "fix": {
					const fixPrefix = subArgs[0] ?? "";
					const items = (["high", "medium", "low"] as const)
						.filter((t) => t.startsWith(fixPrefix.toLowerCase()))
						.map((t) => ({ value: `fix ${t}`, label: t }));
					return items.length > 0 ? items : null;
				}
				case "widget": {
					const wPrefix = subArgs[0] ?? "";
					const items = ["on", "off", "toggle"]
						.filter((v) => v.startsWith(wPrefix))
						.map((v) => ({ value: `widget ${v}`, label: v }));
					return items.length > 0 ? items : null;
				}
				case "debug": {
					const dPrefix = subArgs[0] ?? "";
					const items = ["on", "off", "toggle", "clear", "show"]
						.filter((v) => v.startsWith(dPrefix))
						.map((v) => ({ value: `debug ${v}`, label: v }));
					return items.length > 0 ? items : null;
				}
			}

			return null;
		},
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const subcommand = parts[0];
			const subArgs = parts.slice(1);

			switch (subcommand) {
				case "profile":
					await handleProfile(subArgs, ctx);
					break;
				case "pin":
					await handlePin(subArgs, ctx);
					break;
				case "thinking":
					await handleThinking(subArgs, ctx);
					break;
				case "disable":
					await handleDisable(subArgs, ctx);
					break;
				case "fix":
					await handleFix(subArgs, ctx);
					break;
				case "widget":
					await handleWidget(subArgs, ctx);
					break;
				case "debug":
					await handleDebug(subArgs, ctx);
					break;
				case "reload":
					await handleReload(subArgs, ctx);
					break;
				case "usage":
					await handleUsage(subArgs, ctx);
					break;
				case "status":
					await handleStatus(subArgs, ctx);
					break;
				case "help":
				case "?":
					ctx.ui.notify(
						[
							"Router Subcommands:",
							"  status                      Show current status, profile, pin, cost, and last decision.",
							"  usage                       Show model context, cost, and session usage summary.",
							"  profile [name]              Switch to a profile (enables router if off). Lists available if no name.",
							"  pin [profile] <tier|auto>   Force a tier (high|medium|low) for a profile or set to auto.",
							"  thinking [prof] [tier] <lv> Override thinking level for a profile/tier (off|minimal|...|xhigh|auto).",
							"  disable                     Disable the router and restore the last used non-router model.",
							"  fix <tier>                  Correct the last routing decision and pin that tier for the current profile.",
							"  widget <on|off|toggle>      Control the persistent status widget visibility.",
							"  debug <on|off|show|clear>   Control routing debug logging to notifications and history.",
							"  reload                      Hot-reload the configuration JSON from .omp/model-router.json.",
							"  help, ?                     Show this help message.",
						].join("\n"),
						"info",
					);
					break;
				default:
					if (subcommand) {
						if (state.currentConfig.profiles[subcommand]) {
							await actions.switchToRouterProfile(subcommand, ctx);
							ctx.ui.notify(
								`Router enabled with profile: ${state.selectedProfile}`,
								"info",
							);
						} else {
							ctx.ui.notify(
								`Unknown router subcommand: ${subcommand}. Try /router help`,
								"error",
							);
						}
					} else {
						await handleStatus(subArgs, ctx);
					}
					break;
			}
		},
	});
};
