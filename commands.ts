import type {
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { RouterTier } from "./types";
import type { RouterState } from "./state";
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
	renderUsageReport,
} from "./ui";
import { getCurrentVersion, checkForUpdate } from "./version-check";

// ─── Config set helpers ───────────────────────────────────────────────────────

const resolveConfigValue = (raw: Record<string, unknown>, key: string): unknown => {
	// Profile dot-path: <profile>.<tier>.model|thinking|fallbacks
	const profileMatch = key.match(/^([^.]+)\.(high|medium|low)\.(model|thinking|fallbacks)$/);
	if (profileMatch) {
		const [, profile, tier, field] = profileMatch;
		const profiles = raw.profiles as Record<string, Record<string, Record<string, unknown>>> | undefined;
		return profiles?.[profile]?.[tier]?.[field];
	}
	switch (key) {
		case "phaseBias":           return raw.phaseBias;
		case "budget":              return raw.maxSessionBudget;
		case "contextThreshold":    return raw.largeContextThreshold;
		case "debug":               return raw.debug;
		case "defaultProfile":      return raw.defaultProfile;
		case "compression":         return (raw.historyCompression as Record<string, unknown> | undefined)?.enabled;
		case "compression.keepLastN": return (raw.historyCompression as Record<string, unknown> | undefined)?.keepLastN;
		default:                    return undefined;
	}
};

const applyConfigUpdate = (
	raw: Record<string, unknown>,
	key: string,
	value: string,
): string | null => {
	// Profile dot-path: <profile>.<tier>.model|thinking|fallbacks
	const profileMatch = key.match(/^([^.]+)\.(high|medium|low)\.(model|thinking|fallbacks)$/);
	if (profileMatch) {
		const [, profile, tier, field] = profileMatch;
		const profiles = raw.profiles as Record<string, Record<string, Record<string, unknown>>> | undefined;
		if (!profiles?.[profile]) return `Unknown profile: "${profile}"`;
		if (!profiles[profile][tier]) return `Unknown tier: "${tier}"`;
		if (field === "fallbacks") {
			profiles[profile][tier].fallbacks = value.split(",").map((s) => s.trim()).filter(Boolean);
		} else {
			profiles[profile][tier][field] = value;
		}
		return null;
	}

	switch (key) {
		case "phaseBias": {
			const n = parseFloat(value);
			if (isNaN(n) || n < 0 || n > 1) return "phaseBias must be a float between 0 and 1";
			raw.phaseBias = n;
			return null;
		}
		case "budget": {
			const n = parseFloat(value);
			if (isNaN(n) || n < 0) return "budget must be a non-negative number";
			raw.maxSessionBudget = n;
			return null;
		}
		case "contextThreshold": {
			const n = parseInt(value, 10);
			if (isNaN(n) || n < 0) return "contextThreshold must be a non-negative integer";
			raw.largeContextThreshold = n;
			return null;
		}
		case "debug": {
			if (value !== "on" && value !== "off") return 'debug must be "on" or "off"';
			raw.debug = value === "on";
			return null;
		}
		case "defaultProfile": {
			const profiles = raw.profiles as Record<string, unknown> | undefined;
			if (!profiles?.[value]) return `Unknown profile: "${value}"`;
			raw.defaultProfile = value;
			return null;
		}
		case "compression": {
			if (value !== "on" && value !== "off") return 'compression must be "on" or "off"';
			if (!raw.historyCompression) raw.historyCompression = {};
			(raw.historyCompression as Record<string, unknown>).enabled = value === "on";
			return null;
		}
		case "compression.keepLastN": {
			const n = parseInt(value, 10);
			if (isNaN(n) || n < 1) return "compression.keepLastN must be an integer >= 1";
			if (!raw.historyCompression) raw.historyCompression = {};
			(raw.historyCompression as Record<string, unknown>).keepLastN = n;
			return null;
		}
		default:
			return `Unknown key: "${key}". Run /router set for available keys.`;
	}
};

export const registerCommands = (
	pi: ExtensionAPI,
	state: RouterState,
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
		const report = renderUsageReport({
			theme: ctx.ui.theme,
			selectedProfile: state.selectedProfile,
			profile,
			debugHistory: state.debugHistory,
			lastDecision: state.lastDecision,
			accumulatedCost: state.accumulatedCost,
			maxSessionBudget: state.currentConfig.maxSessionBudget,
			modelRegistry: ctx.modelRegistry,
			compression: {
				enabled: state.currentConfig.historyCompression?.enabled ?? false,
				requestCount: state.compressionRequestCount,
				totalOriginalChars: state.compressionTotalOriginalChars,
				totalCompressedChars: state.compressionTotalCompressedChars,
			},
		});
		ctx.ui.notify(report, "info");
	};


	const SET_KEYS = [
		"phaseBias",
		"budget",
		"contextThreshold",
		"debug",
		"defaultProfile",
		"compression",
		"compression.keepLastN",
	] as const;

	const handleSet = async (args: string[], ctx: ExtensionContext) => {
		if (args.length === 0) {
			const lines = [
				"Usage: /router set <key> [value]",
				"",
				"Global keys:",
				"  phaseBias <float>              Phase bias weight (0-1)",
				"  budget <float>                 Max session budget ($)",
				"  contextThreshold <int>         Large context threshold (tokens)",
				"  debug <on|off>                 Debug mode",
				"  defaultProfile <name>          Default profile name",
				"  compression <on|off>           Enable/disable TOON compression",
				"  compression.keepLastN <int>    Messages to keep uncompressed",
				"",
				"Profile keys (dot-path):",
				"  <profile>.<tier>.model <ref>         Primary model",
				"  <profile>.<tier>.thinking <level>    Thinking level",
				"  <profile>.<tier>.fallbacks <m1,m2>   Fallback models (comma-separated)",
				"",
				"Omit value to show current setting.",
			];
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}

		const key = args[0];
		const value = args.slice(1).join(" ");

		const globalPath = join(getAgentDir(), "model-router.json");
		let raw: Record<string, unknown>;
		try {
			raw = JSON.parse(readFileSync(globalPath, "utf-8"));
		} catch {
			ctx.ui.notify("Failed to read config file", "error");
			return;
		}

		// Show current value when no value provided
		if (!value) {
			const current = resolveConfigValue(raw, key);
			ctx.ui.notify(
				`${key} = ${current === undefined ? "(unset)" : JSON.stringify(current)}`,
				"info",
			);
			return;
		}

		// Apply the update
		const error = applyConfigUpdate(raw, key, value);
		if (error) {
			ctx.ui.notify(error, "error");
			return;
		}

		// Write back
		try {
			writeFileSync(globalPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
		} catch (e) {
			ctx.ui.notify(`Failed to write config: ${e}`, "error");
			return;
		}

		// Reload
		actions.reloadConfig(ctx, { preserveDebug: true });
		await actions.ensureValidActiveRouterProfile(ctx);

		const newValue = resolveConfigValue(raw, key);
		ctx.ui.notify(
			`Set ${key} = ${JSON.stringify(newValue)}  (config reloaded)`,
			"info",
		);
	};

	const handleReload = async (_args: string[], ctx: ExtensionContext) => {
		actions.reloadConfig(ctx, { preserveDebug: true });
		await actions.ensureValidActiveRouterProfile(ctx);
		ctx.ui.notify(
			`Router config reloaded. Profiles: ${profileNames(state.currentConfig).join(", ")}`,
			"info",
		);
	};

	const handleUpdate = async (_args: string[], ctx: ExtensionContext) => {
		const currentVersion = getCurrentVersion();

		// If we already know about an update from the session check, use that
		if (state.updateAvailable) {
			const { current, latest } = state.updateAvailable;
			const confirmed = await ctx.ui.dialog.confirm(
				`Update Model Router v${current} → v${latest}?`,
			);
			if (!confirmed) {
				ctx.ui.notify("Update cancelled.", "info");
				return;
			}
			ctx.ui.notify("Updating…", "info");
			try {
				const proc = Bun.spawn(
					["pi", "update", `npm:@cakriwut/omp-model-router`],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const exitCode = await proc.exited;
				if (exitCode === 0) {
					ctx.ui.notify(
						`Updated to v${latest}. Restart session to use new version.`,
						"info",
					);
					state.updateAvailable = undefined;
				} else {
					const stderr = await new Response(proc.stderr).text();
					ctx.ui.notify(
						`Update failed (exit ${exitCode}): ${stderr.slice(0, 200)}`,
						"error",
					);
				}
			} catch (err) {
				ctx.ui.notify(
					`Update failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
			return;
		}

		// No cached update info — run a fresh check
		ctx.ui.notify("Checking for updates…", "info");
		const info = await checkForUpdate();
		if (info) {
			state.updateAvailable = { current: info.current, latest: info.latest };
			const confirmed = await ctx.ui.dialog.confirm(
				`Update Model Router v${info.current} → v${info.latest}?`,
			);
			if (!confirmed) {
				ctx.ui.notify("Update cancelled.", "info");
				return;
			}
			ctx.ui.notify("Updating…", "info");
			try {
				const proc = Bun.spawn(
					["pi", "update", `npm:@cakriwut/omp-model-router`],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const exitCode = await proc.exited;
				if (exitCode === 0) {
					ctx.ui.notify(
						`Updated to v${info.latest}. Restart session to use new version.`,
						"info",
					);
					state.updateAvailable = undefined;
				} else {
					const stderr = await new Response(proc.stderr).text();
					ctx.ui.notify(
						`Update failed (exit ${exitCode}): ${stderr.slice(0, 200)}`,
						"error",
					);
				}
			} catch (err) {
				ctx.ui.notify(
					`Update failed: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		} else {
			ctx.ui.notify(`Model Router v${currentVersion} is up to date.`, "info");
		}
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
			"set",
			"reload",
			"help",
			"update",
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
				case "set": {
					const setPrefix = subArgs[0] ?? "";
					if (!hasTrailingSpace || subArgs.length <= 1) {
						const SET_KEY_LIST = [
							"phaseBias", "budget", "contextThreshold", "debug",
							"defaultProfile", "compression", "compression.keepLastN",
						];
						const items = SET_KEY_LIST
							.filter((k) => k.startsWith(setPrefix))
							.map((k) => ({ value: `set ${k}`, label: k }));
						return items.length > 0 ? items : null;
					}
					const setKey = subArgs[0];
					const valPrefix = subArgs[1] ?? "";
					if (setKey === "debug" || setKey === "compression") {
						const items = ["on", "off"].filter((v) => v.startsWith(valPrefix))
							.map((v) => ({ value: `set ${setKey} ${v}`, label: v }));
						return items.length > 0 ? items : null;
					}
					if (setKey === "defaultProfile") {
						const items = profileNames(state.currentConfig)
							.filter((n) => n.startsWith(valPrefix))
							.map((n) => ({ value: `set defaultProfile ${n}`, label: n }));
						return items.length > 0 ? items : null;
					}
					return null;
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
				case "update":
					await handleUpdate(subArgs, ctx);
					break;
				case "set":
					await handleSet(subArgs, ctx);
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
							"  set <key> [value]            Get or set config value (writes to model-router.json). Omit value to read.",
							"  help, ?                     Show this help message.",
							"  update                      Check for and apply extension updates from npm.",
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
