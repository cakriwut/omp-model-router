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

export interface HistoryCompressionConfig {
	/** Enable TOON compression of message history before sending to the LLM. */
	enabled: boolean;
	/**
	 * Number of recent messages to keep as native JSON turns.
	 * All older messages are compressed into a single prepended user message.
	 * Must be >= 1 (the latest user message is always kept). Default: 4.
	 */
	keepLastN?: number;
	/**
	 * List of model patterns to exclude from compression.
	 * When the resolved target model matches any pattern, compression is skipped.
	 * Supports substring matching (e.g. "kimi" matches "moonshotai.kimi-k2.5").
	 */
	excludeModels?: string[];
	/**
	 * Turn number after which compression is frozen (static TOON mode).
	 * When set, compression is applied only up to this turn, then reused for all subsequent turns.
	 */
	freezeAfter?: number;
	/**
	 * Progressive TOON configuration: compress only when beneficial (context approaching limit OR cache expiry).
	 * When enabled, overrides freezeAfter and uses intelligent checkpointing instead.
	 */
	progressive?: {
		/** Enable progressive TOON mode. Default: false. */
		enabled: boolean;
		/**
		 * Context size threshold as fraction of model window. Compression triggers when context >= this.
		 * 0.0-1.0; default: 0.8 (80%).
		 */
		contextThreshold?: number;
		/**
		 * Time threshold in seconds. Compression triggers if gap since last turn >= this.
		 * Used to detect cache expiry. Default: 300 (5 minutes).
		 */
		timeThreshold?: number;
		/**
		 * Maximum age of a checkpoint in turns before forcing refresh.
		 * Prevents stale checkpoints from being reused indefinitely. Default: 50.
		 */
		maxCheckpointAge?: number;
		/**
		 * Maximum context size in tokens before forcing checkpoint refresh.
		 * Prevents bloated checkpoints from being reused. Default: 200000.
		 */
		maxCheckpointSize?: number;
	};
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

/**
 * Frozen TOON checkpoint created when progressive compression triggers.
 * Reused between triggers to maximize cache hit rate on frozen block.
 */
export interface CompressionCheckpoint {
	/** Frozen TOON text block (immutable across subsequent turns). */
	frozenBlock: string;
	/** Checkpoint metadata for tracking. */
	metadata: {
		/** Turn number when checkpoint was created. */
		turn: number;
		/** Character range of frozen content [start, end). */
		range: [number, number];
		/** Compression statistics. */
		stats: CompressionStats;
		/** Trigger reason: "context_size" or "cache_expiry". */
		triggerReason: "context_size" | "cache_expiry";
		/** Timestamp when checkpoint was created (epoch ms). */
		timestamp: number;
	};
}


export interface CompressionStats {
	/** Number of messages that were compressed into the TOON block. */
	compressedMessages: number;
	/** Character count of the original JSON representation of compressed messages. */
	originalChars: number;
	/** Character count of the TOON block (including the wrapper text). */
	compressedChars: number;
	/** Estimated tokens in original context before compression. */
	estimatedOriginalTokens?: number;
	/** Estimated tokens in compressed context after TOON encoding. */
	estimatedCompressedTokens?: number;
	/** Estimated tokens saved by compression. */
	estimatedTokensSaved?: number;
}

export interface RouterProfile {
	high: RoutedTierConfig;
	medium: RoutedTierConfig;
	low: RoutedTierConfig;
	/** Per-profile compression config. Overrides the global RouterConfig setting. */
	historyCompression?: HistoryCompressionConfig;
}

export interface RouterConfig {
	/** Whether the router is active. Written by /router <profile> and /router disable. */
	routerEnabled?: boolean;
	defaultProfile?: string;
	debug?: boolean;
	/** Opt-in for verbose session JSONL logging (compression triggers, etc). Default: false. */
	debugVerbose?: boolean;
	/** Maximum number of routing decisions to keep in debugHistory. Default: 12. */
	debugHistoryLimit?: number;
	classifierModel?: string | string[];
	phaseBias?: number;
	largeContextThreshold?: number;
	maxSessionBudget?: number;
	rules?: RoutingRule[];
	/** Global history compression config. Can be overridden per-profile. */
	historyCompression?: HistoryCompressionConfig;
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
	/** Classifier prompt-equality cache (Phase 1). */
	classifierCache?: {
		/** Force the classifier to re-run after this many turns even if the prompt is unchanged. Default: 20. */
		ttlTurns?: number;
	};
	/**
	 * Stream idle timeout in milliseconds. If no event arrives from the delegated
	 * model stream for this duration, the request is aborted and fallback is triggered.
	 * Set to 0 to disable. Default: 120000 (120s).
	 */
	streamIdleTimeoutMs?: number;
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
	compression?: CompressionStats;
	compressionTriggerReason?: "context_size" | "cache_expiry";
	compressionCacheHit?: boolean;
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
	accumulatedOriginalTokens?: number;
	accumulatedCompressedTokens?: number;
	accumulatedTokensSaved?: number;
	accumulatedCacheReadTokens?: number;
	timestamp: number;
	// ─── Progressive TOON state ───────────────────────────────────────
	compressionRequestCount?: number;
	compressionTotalOriginalChars?: number;
	compressionTotalCompressedChars?: number;
	currentCheckpoint?: CompressionCheckpoint;
	lastTurnTimestamp?: number;
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
