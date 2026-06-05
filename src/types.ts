import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CalibrationConfig } from "./calibration/types";

export type RouterTier = "high" | "medium" | "low";
export type RouterPin = RouterTier | "auto";

export type ScopedPinSource =
	| "user"
	| "heuristic"
	| "classifier"
	| "rule"
	| "auto-upgrade";

export interface ScopedPin {
	/** The pinned tier. */
	tier: RouterTier;
	/** Epoch ms when the pin was set (used for timeout comparison). */
	setAt: number;
	/** Who created the pin — determines priority and conflict resolution. */
	source: ScopedPinSource;
	/**
	 * Number of consecutive turns where the heuristic shadow disagreed with this pin tier.
	 * Incremented each turn the shadow tier differs; reset to 0 on agreement.
	 * Only tracked for system pins (source !== "user"); user pins are immune.
	 * When this reaches `config.pinPressureThreshold` the pin lapses early.
	 */
	overridePressureCount?: number;
}
export type RouterPhase = "planning" | "implementation" | "lightweight";
export type RouterPinByProfile = Partial<Record<string, RouterTier>>;
export type RouterThinkingByTier = Partial<Record<RouterTier, ThinkingLevel>>;
export type RouterThinkingByProfile = Record<string, RouterThinkingByTier>;

export interface RoutingRule {
	matches: string | string[];
	tier: RouterTier;
	reason?: string;
}

export interface RoutedTierConfig {
	model: string;
	thinking?: ThinkingLevel;
	fallbacks?: string[];
}

export interface EmbargoEntry {
	/** The model ref being embargoed (e.g. "anthropic/claude-sonnet-4-5"). */
	modelRef: string;
	/** Epoch ms when the embargo expires. */
	expiresAt: number;
	/** Epoch ms when the embargo was set. */
	embargoedAt: number;
	/** HTTP status that triggered the embargo (429, 503, 529, 502). */
	status: number | undefined;
	/** Human-readable reason (e.g. "429 rate limited"). */
	reason: string;
	/** The retry-after-ms value requested by the provider (before clamping). */
	requestedDurationMs?: number;
	/** The actual duration applied after clamping. */
	effectiveDurationMs: number;
}

export interface EmbargoConfig {
	/** Enable automatic model embargo on retryable HTTP errors. Default: true. */
	enabled: boolean;
	/** Default cooldown in ms when no retry-after signal is available. Default: 60000 (60s). */
	defaultCooldownMs?: number;
	/** Minimum embargo duration in ms (prevents rapid cycling). Default: 5000 (5s). */
	minCooldownMs?: number;
	/** Maximum embargo duration in ms (prevents extreme starvation). Default: 3600000 (1 hour). */
	maxCooldownMs?: number;
}

export interface AutoUpgradeConfig {
	/** Enable automatic tier upgrade on repeated tool failures. Default: false. */
	enabled: boolean;
	/**
	 * Number of consecutive failures of the same tool required to trigger an upgrade.
	 * Default: 2.
	 */
	threshold?: number;
	/**
	 * Only upgrade when these tools fail. If omitted, any tool failure counts.
	 * Supports exact tool names (e.g. "find", "search", "edit").
	 */
	tools?: string[];
}


export interface RouterProfile {
	high: RoutedTierConfig;
	medium: RoutedTierConfig;
	low: RoutedTierConfig;
}

export interface RouterConfig {
	/** Whether the router is active. Written by /router <profile> and /router disable. */
	routerEnabled?: boolean;
	defaultProfile?: string;
	debug?: boolean;
	/** Opt-in for verbose session JSONL logging. Default: false. */
	debugVerbose?: boolean;
	/** Maximum number of routing decisions to keep in debugHistory. Default: 12. */
	debugHistoryLimit?: number;
	classifierModel?: string | string[];
	phaseBias?: number;
	largeContextThreshold?: number;
	maxSessionBudget?: number;
	rules?: RoutingRule[];
	profiles: Record<string, RouterProfile>;
	/** Auto-upgrade tier when the same tool fails consecutively. */
	autoUpgrade?: AutoUpgradeConfig;
	/** Automatic model embargo on retryable HTTP errors (429, 503, 529, 502). */
	embargo?: EmbargoConfig;
	/** Calibration system for async LLM classifier with learning. */
	calibration?: CalibrationConfig;
	/**
	 * Enable RTK (Rust Token Killer) integration for token-optimized command rewrites.
	 * Requires `rtk` binary in PATH (install: brew install rtk).
	 * Reduces token consumption by 60-90% across 100+ commands.
	 * See: https://github.com/rtk-ai/rtk
	 * Default: false.
	 */
	enableRtk?: boolean;
	/**
	 * Permanent tier floor returned after a scoped pin decays.
	 * - `"auto"` (default): no pin; the heuristic decides freely after decay.
	 * - A tier value (`"high"` | `"medium"` | `"low"`): acts as a permanent,
	 *   non-decaying floor — routing never falls below this tier.
	 */
	defaultPin?: RouterTier | "auto";
	/**
	 * How long a scoped pin stays active before it decays, in milliseconds.
	 * After expiry the pin is cleared and `defaultPin` (or "auto") takes effect.
	 * Default: 600 000 ms (10 minutes).
	 */
	pinTimeout?: number;
	/**
	 * Number of consecutive turns where the heuristic shadow must disagree with
	 * an active system pin before the pin lapses early (pressure lapse).
	 * Only applies to pins created by system sources (heuristic, classifier, rule,
	 * auto-upgrade). User pins (`/router pin <tier>`) are always immune.
	 * Set to `0` to disable pressure lapse entirely.
	 * Default: 3.
	 */
	pinPressureThreshold?: number;
	/** Classifier prompt-equality cache (Phase 1). */
	classifierCache?: {
		/** Force the classifier to re-run after this many turns even if the prompt is unchanged. Default: 20. */
		ttlTurns?: number;
	};
	/**
	 * Path to a local project-specific classifier pitfalls markdown file.
	 * When set, takes precedence over the default local search path.
	 * Global pitfalls (~/.omp/agent/model-router/pitfalls.md) are still
	 * loaded as fallback if this path does not exist.
	 */
	pitfallsPath?: string;
	/**
	 * Stream idle timeout in milliseconds. If no event arrives from the delegated
	 * model stream for this duration, the request is aborted and fallback is triggered.
	 * Set to 0 to disable. Default: 120000 (120s).
	 */
	streamIdleTimeoutMs?: number;
	/**
	 * Absolute wall-clock timeout in milliseconds for the entire delegated LLM stream,
	 * from the moment streamSimple() is called until the stream completes.
	 * Protects against models that drip-feed thinking tokens indefinitely (resetting
	 * the idle timeout each time) — e.g. Opus extended thinking, slow inference.
	 * When reached, the stream is aborted and the fallback chain triggers.
	 * Set to 0 to disable. Default: 300000 (5 minutes).
	 */
	maxStreamDurationMs?: number;
}

export interface RoutingDecisionUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
}

export interface RoutingDecision {
	profile: string;
	tier: RouterTier;
	phase: RouterPhase;
	targetProvider: string;
	targetModelId: string;
	targetLabel: string;
	reasoning: string;
	thinking: ThinkingLevel;
	timestamp: number;
	usage?: RoutingDecisionUsage;
	isClassifier?: boolean;
	isFallback?: boolean;
	isContextTriggered?: boolean;
	isBudgetForced?: boolean;
	isRuleMatched?: boolean;
	isEmbargoed?: boolean;
	embargoTimeRemaining?: number;
	/** True when the synchronous classifier ran (or returned a cache hit) this turn.
	 *  Set by resolveRouting; read by spawnClassifierForTurn to suppress redundant async spawn. */
	syncClassifierRan?: boolean;
}

export interface RouterPersistedState {
	enabled: boolean;
	selectedProfile: string;
	/** @deprecated Pins are no longer persisted (scoped-pin-decay). Kept for backward compat deserialization. */
	pinTier?: RouterTier;
	/** @deprecated Pins are no longer persisted (scoped-pin-decay). Kept for backward compat deserialization. */
	pinByProfile?: RouterPinByProfile;
	thinkingByProfile?: RouterThinkingByProfile;
	debugEnabled?: boolean;
	widgetEnabled?: boolean;
	debugHistory?: RoutingDecision[];
	lastPhase?: RouterPhase;
	lastDecision?: RoutingDecision;
	lastNonRouterModel?: string;
	// ─── Per-session accumulated cost (backward compat) ──────────────
	accumulatedCost?: number;
	accumulatedCacheReadTokens?: number;
	timestamp: number;
}

export interface ConfigLoadResult {
	config: RouterConfig;
	warnings: string[];
}

export interface ParsedConfigFile {
	config: Partial<RouterConfig>;
	warnings: string[];
}

export interface CustomSessionEntry {
	type: string;
	customType?: string;
	data?: unknown;
}
