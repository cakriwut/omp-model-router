import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";

export type RouterTier = "high" | "medium" | "low";
export type RouterPin = RouterTier | "auto";
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
	};
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
	classifierModel?: string;
	phaseBias?: number;
	largeContextThreshold?: number;
	maxSessionBudget?: number;
	rules?: RoutingRule[];
	/** Global history compression config. Can be overridden per-profile. */
	historyCompression?: HistoryCompressionConfig;
	profiles: Record<string, RouterProfile>;
	/** Auto-upgrade tier when the same tool fails consecutively. */
	autoUpgrade?: AutoUpgradeConfig;
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
	compression?: CompressionStats;
	compressionTriggerReason?: "context_size" | "cache_expiry";
	compressionCacheHit?: boolean;
}

export interface RouterPersistedState {
	enabled: boolean;
	selectedProfile: string;
	pinTier?: RouterTier;
	pinByProfile?: RouterPinByProfile;
	thinkingByProfile?: RouterThinkingByProfile;
	debugEnabled?: boolean;
	widgetEnabled?: boolean;
	debugHistory?: RoutingDecision[];
	lastPhase?: RouterPhase;
	lastDecision?: RoutingDecision;
	lastNonRouterModel?: string;
	accumulatedCost?: number;
	accumulatedOriginalTokens?: number;
	accumulatedCompressedTokens?: number;
	accumulatedTokensSaved?: number;
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
