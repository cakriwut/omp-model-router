import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	AutoUpgradeConfig,
	RouterConfig,
	RouterProfile,
	RoutedTierConfig,
	ConfigLoadResult,
	ParsedConfigFile,
	RouterTier,
	RoutingRule,
} from "./types";

export const ROUTER_TIERS = ["high", "medium", "low"] as const;

export const FALLBACK_CONFIG: RouterConfig = {
	defaultProfile: "auto",
	debug: false,
	enableRtk: false,  // RTK integration disabled by default (opt-in)
	profiles: {
		auto: {
			high: { model: "anthropic/claude-sonnet-4-5", thinking: "high" as ThinkingLevel },
			medium: { model: "anthropic/claude-sonnet-4-5", thinking: "medium" as ThinkingLevel },
			low: { model: "anthropic/claude-haiku-4-5", thinking: "low" as ThinkingLevel },
		},
	},
	historyCompression: {
		enabled: true,
		keepLastN: 4,
		progressive: {
			enabled: true,
			contextThreshold: 0.8,
			timeThreshold: 300,
		},
	},
	calibration: {
		enabled: false,
		mode: "telemetry",
		warmupTurns: 5,
		overrideThreshold: 0.65,
		traceEnabled: false,
		useGlobalPrior: true,
		globalPriorWeight: 0.1,
	},
};

export const THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
] as readonly ThinkingLevel[];
export const ROUTER_PIN_VALUES = ["auto", "high", "medium", "low"] as const;

export const isObjectRecord = (
	value: unknown,
): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

export const isThinkingLevel = (value: unknown): value is ThinkingLevel =>
	typeof value === "string" && THINKING_LEVELS.includes(value as ThinkingLevel);

export const isRouterTier = (value: unknown): value is RouterTier =>
	value === "high" || value === "medium" || value === "low";

export const parseConfigFile = (path: string): ParsedConfigFile => {
	if (!existsSync(path)) {
		return { config: {}, warnings: [] };
	}

	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!isObjectRecord(parsed)) {
			return {
				config: {},
				warnings: [`Ignored router config at ${path}: expected a JSON object.`],
			};
		}
		return { config: parsed as Partial<RouterConfig>, warnings: [] };
	} catch (error) {
		return {
			config: {},
			warnings: [
				`Failed to parse router config at ${path}: ${error instanceof Error ? error.message : String(error)}`,
			],
		};
	}
};

export const mergeConfig = (
	base: RouterConfig,
	override: Partial<RouterConfig>,
): RouterConfig => {
	const mergedProfiles: Record<string, RouterProfile> = { ...base.profiles };
	for (const [name, profile] of Object.entries(override.profiles ?? {})) {
		const existing = mergedProfiles[name];
		const nextProfile = profile as Partial<RouterProfile>;
		mergedProfiles[name] = {
			high: {
				...(existing?.high ?? FALLBACK_CONFIG.profiles.auto.high),
				...(nextProfile.high ?? {}),
			},
			medium: {
				...(existing?.medium ?? FALLBACK_CONFIG.profiles.auto.medium),
				...(nextProfile.medium ?? {}),
			},
			low: {
				...(existing?.low ?? FALLBACK_CONFIG.profiles.auto.low),
				...(nextProfile.low ?? {}),
			},
			historyCompression: nextProfile.historyCompression ?? existing?.historyCompression,
		};
	}
	// IMPORTANT: this uses spread so new optional top-level fields in RouterConfig
	// flow through automatically. If you add a field that needs deep-merge (like
	// profiles or historyCompression), add it explicitly AFTER the spread.
	// See AGENTS.md "Pitfalls > Adding a new top-level field to RouterConfig".
	return {
		...base,
		...override,
		profiles: mergedProfiles,
	};
};

export const parseCanonicalModelRef = (
	value: string,
): { provider: string; modelId: string } => {
	const slashIndex = value.indexOf("/");
	if (slashIndex === -1) {
		throw new Error(
			`Invalid model reference "${value}". Expected "provider/model".`,
		);
	}
	const provider = value.slice(0, slashIndex).trim();
	const modelId = value.slice(slashIndex + 1).trim();
	if (!provider || !modelId) {
		throw new Error(
			`Invalid model reference "${value}". Expected "provider/model".`,
		);
	}
	return { provider, modelId };
};

export const normalizeTierConfig = (
	value: unknown,
	fallback: RoutedTierConfig,
	profileName: string,
	tier: RouterTier,
	warnings: string[],
): RoutedTierConfig => {
	if (!isObjectRecord(value)) {
		warnings.push(
			`Profile "${profileName}" has invalid ${tier} tier config. Falling back to ${fallback.model}.`,
		);
		return { ...fallback };
	}

	const model = typeof value.model === "string" ? value.model.trim() : "";
	let parsedModel = fallback.model;
	if (!model) {
		warnings.push(
			`Profile "${profileName}" ${tier} tier is missing a model. Falling back to ${fallback.model}.`,
		);
	} else {
		try {
			parseCanonicalModelRef(model);
			parsedModel = model;
		} catch (error) {
			warnings.push(error instanceof Error ? error.message : String(error));
		}
	}

	const thinking = isThinkingLevel(value.thinking)
		? value.thinking
		: fallback.thinking;
	if (value.thinking !== undefined && !isThinkingLevel(value.thinking)) {
		warnings.push(
			`Profile "${profileName}" ${tier} tier has invalid thinking level. Falling back to ${fallback.thinking ?? "medium"}.`,
		);
	}

	let fallbacks: string[] | undefined = undefined;
	if (Array.isArray(value.fallbacks)) {
		fallbacks = [];
		for (const f of value.fallbacks) {
			if (typeof f === "string") {
				try {
					parseCanonicalModelRef(f);
					fallbacks.push(f);
				} catch (error) {
					warnings.push(
						`Invalid fallback model "${f}" in profile "${profileName}" ${tier} tier: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
	}

	return { model: parsedModel, thinking, fallbacks };
};

export const normalizeConfig = (raw: RouterConfig): ConfigLoadResult => {
	const warnings: string[] = [];
	const normalizedProfiles: Record<string, RouterProfile> = {};
	const fallbackAuto = FALLBACK_CONFIG.profiles.auto;

	for (const [name, profile] of Object.entries(raw.profiles ?? {})) {
		normalizedProfiles[name] = {
			high: normalizeTierConfig(
				profile?.high,
				fallbackAuto.high,
				name,
				"high",
				warnings,
			),
			medium: normalizeTierConfig(
				profile?.medium,
				fallbackAuto.medium,
				name,
				"medium",
				warnings,
			),
			low: normalizeTierConfig(
				profile?.low,
				fallbackAuto.low,
				name,
				"low",
				warnings,
			),
			historyCompression: profile?.historyCompression,
		};
	}

	if (Object.keys(normalizedProfiles).length === 0) {
		normalizedProfiles.auto = fallbackAuto;
		warnings.push(
			"No valid router profiles found. Falling back to the built-in auto profile.",
		);
	}

	let defaultProfile =
		typeof raw.defaultProfile === "string" && raw.defaultProfile.trim()
			? raw.defaultProfile.trim()
			: undefined;
	if (!defaultProfile || !normalizedProfiles[defaultProfile]) {
		const fallbackProfile = normalizedProfiles[
			FALLBACK_CONFIG.defaultProfile ?? "auto"
		]
			? (FALLBACK_CONFIG.defaultProfile ?? "auto")
			: Object.keys(normalizedProfiles).sort()[0];
		if (defaultProfile && !normalizedProfiles[defaultProfile]) {
			warnings.push(
				`Default router profile "${defaultProfile}" was not found. Falling back to "${fallbackProfile}".`,
			);
		}
		defaultProfile = fallbackProfile;
	}

	const phaseBias =
		typeof raw.phaseBias === "number"
			? Math.max(0, Math.min(1, raw.phaseBias))
			: 0.5;

	const largeContextThreshold =
		typeof raw.largeContextThreshold === "number" &&
		raw.largeContextThreshold > 0
			? raw.largeContextThreshold
			: undefined;

	const maxSessionBudget =
		typeof raw.maxSessionBudget === "number" && raw.maxSessionBudget > 0
			? raw.maxSessionBudget
			: undefined;

	const rules: RoutingRule[] = [];
	if (Array.isArray(raw.rules)) {
		for (const rule of raw.rules) {
			if (isObjectRecord(rule)) {
				const matches = rule.matches;
				const tier = rule.tier;
				if (
					(typeof matches === "string" || Array.isArray(matches)) &&
					isRouterTier(tier)
				) {
					rules.push({
						matches,
						tier,
						reason: typeof rule.reason === "string" ? rule.reason : undefined,
					});
				} else {
					warnings.push(
						`Ignored invalid routing rule: ${JSON.stringify(rule)}`,
					);
				}
			}
		}
	}

	// Parse classifierModel: single string or array of strings
	let classifierModel: string | string[] | undefined;
	if (typeof raw.classifierModel === "string") {
		// Single string (backward compat)
		const trimmed = raw.classifierModel.trim();
		try {
			parseCanonicalModelRef(trimmed);
			classifierModel = trimmed;
		} catch (error) {
			warnings.push(
				`Invalid classifierModel: ${error instanceof Error ? error.message : String(error)}`,
			);
			classifierModel = undefined;
		}
	} else if (Array.isArray(raw.classifierModel)) {
		// Array of strings (fallback chain)
		const validModels: string[] = [];
		for (const modelRef of raw.classifierModel) {
			if (typeof modelRef === "string") {
				const trimmed = modelRef.trim();
				try {
					parseCanonicalModelRef(trimmed);
					validModels.push(trimmed);
				} catch (error) {
					warnings.push(
						`Invalid classifierModel in array: ${trimmed} — ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}
		classifierModel = validModels.length > 0 ? validModels : undefined;
	}
	// ── Auto-upgrade normalization ───────────────────────────────────────────
	let autoUpgrade: AutoUpgradeConfig | undefined;
	if (isObjectRecord(raw.autoUpgrade) && raw.autoUpgrade.enabled === true) {
		const threshold =
			typeof raw.autoUpgrade.threshold === "number" && raw.autoUpgrade.threshold >= 1
				? Math.floor(raw.autoUpgrade.threshold)
				: 2;
		const tools = Array.isArray(raw.autoUpgrade.tools)
			? (raw.autoUpgrade.tools as unknown[]).filter((t): t is string => typeof t === "string")
			: undefined;
		autoUpgrade = { enabled: true, threshold, tools: tools?.length ? tools : undefined };
	}

	// ── Calibration normalization ────────────────────────────────────────────
	let calibration: import("./calibration/types").CalibrationConfig | undefined;
	if (isObjectRecord(raw.calibration)) {
		const c = raw.calibration;
		const mode = c.mode === "adaptive" ? "adaptive" : "telemetry";
		calibration = {
			enabled: c.enabled === true,
			mode,
			warmupTurns: typeof c.warmupTurns === "number" ? c.warmupTurns : 5,
			classifierModel: typeof c.classifierModel === "string" ? c.classifierModel : undefined,
			overrideThreshold: typeof c.overrideThreshold === "number" ? c.overrideThreshold : 0.65,
			traceEnabled: c.traceEnabled === true,
			useGlobalPrior: c.useGlobalPrior !== false,
			globalPriorWeight: typeof c.globalPriorWeight === "number" ? c.globalPriorWeight : 0.1,
		};
	}


	// Start with all fields from raw (preserves new optional fields automatically)
	// Then override with normalized/validated values.
	// This is the SINGLE SOURCE OF TRUTH for field preservation —
	// any new optional field added to RouterConfig flows through automatically.
	const normalizedConfig: RouterConfig = {
		...raw,
		// Override with normalized values for fields that need validation
		defaultProfile,
		debug: typeof raw.debug === "boolean" ? raw.debug : false,
		phaseBias,
		largeContextThreshold,
		maxSessionBudget,
		rules: rules.length > 0 ? rules : undefined,
		profiles: normalizedProfiles,
		autoUpgrade,
		calibration,
		// Boolean fields with explicit type validation
		routerEnabled: typeof raw.routerEnabled === "boolean" ? raw.routerEnabled : undefined,
		// String fields with validation
		classifierModel,
		// historyCompression: pass through raw (already validated structurally)
		historyCompression: raw.historyCompression,
	};

	return {
		config: normalizedConfig,
		warnings,
	};
};

export const loadRouterConfig = (cwd: string): ConfigLoadResult => {
	const globalPath = join(getAgentDir(), "model-router.json");
	const projectPath = join(cwd, ".omp", "model-router.json");
	const globalResult = parseConfigFile(globalPath);
	const projectResult = parseConfigFile(projectPath);
	const merged = mergeConfig(
		mergeConfig(FALLBACK_CONFIG, globalResult.config),
		projectResult.config,
	);
	const normalized = normalizeConfig(merged);
	return {
		config: normalized.config,
		warnings: [
			...globalResult.warnings,
			...projectResult.warnings,
			...normalized.warnings,
		],
	};
};

export const profileNames = (config: RouterConfig): string[] => {
	return Object.keys(config.profiles).sort();
};

export const resolveProfileName = (
	config: RouterConfig,
	requested?: string,
): string => {
	if (requested && config.profiles[requested]) {
		return requested;
	}
	if (config.defaultProfile && config.profiles[config.defaultProfile]) {
		return config.defaultProfile;
	}
	return profileNames(config)[0] ?? "auto";
};

/**
 * Read-modify-write the global config file (~/.omp/agent/model-router.json).
 * Merges `updates` into the existing JSON object and writes back.
 * Returns true on success; logs nothing on failure (caller decides).
 */
export const patchConfigFile = (
	updates: Record<string, unknown>,
): boolean => {
	const globalPath = join(getAgentDir(), "model-router.json");
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(globalPath, "utf-8"));
	} catch {
		// File doesn't exist or isn't valid JSON — start fresh
		raw = {};
	}
	Object.assign(raw, updates);
	try {
		const dir = dirname(globalPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(globalPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
};
