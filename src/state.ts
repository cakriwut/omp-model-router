import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { SessionCalibration } from "./calibration/types";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ─── Session-scoped cost state ──────────────────────────────────────────────

/**
 * Per-session cost/metrics scope.
 * Each session (including sub-agent sessions) gets its own scope
 * to prevent cross-contamination when multiple agents share one process.
 */
export interface SessionScope {
	sessionId: string;
	parentSessionId?: string;
	accumulatedCost: number;
	accumulatedOriginalTokens: number;
	accumulatedCompressedTokens: number;
	accumulatedTokensSaved: number;
	accumulatedCacheReadTokens: number;
	compressionRequestCount: number;
	compressionTotalOriginalChars: number;
	compressionTotalCompressedChars: number;
	debugHistory: RoutingDecision[];
	lastDecision: RoutingDecision | undefined;
	lastTurnTimestamp?: number;
	currentCheckpoint?: CompressionCheckpoint;
	isStreaming: boolean;
	/** Routing decision counts per tier */
	tierCounter: TierCounter;
	/** Cost breakdown per model */
	modelCosts: Map<string, ModelCostEntry>;
}

/**
 * Routing decision counter — tracks how many times each tier was selected.
 * Incremented at decision time (before stream starts).
 */
export interface TierCounter {
	high: number;
	medium: number;
	low: number;
}

/**
 * Per-model cost entry — tracks actual LLM cost per model.
 * Updated on stream completion when usage data arrives.
 */
export interface ModelCostEntry {
	model: string;
	tier: string;
	invocations: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
}
import type {
	RouterConfig,
	RouterPinByProfile,
	RouterThinkingByProfile,
	RouterTier,
	RoutingDecision,
	RouterPersistedState,
	CustomSessionEntry,
	CompressionStats,
	CompressionCheckpoint,
} from "./types";
import type { Message } from "@oh-my-pi/pi-ai";
import { FALLBACK_CONFIG, resolveProfileName } from "./config";
import { MAX_DEBUG_HISTORY } from "./constants";

// ─── Persistent state file path ────────────────────────────────────────────

const STATE_FILE = () => {
	const dir = join(getAgentDir(), "model-router");
	return join(dir, "router-state.json");
};

const ensureStateDir = () => {
	const dir = join(getAgentDir(), "model-router");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	return dir;
};

// ─── Type guard for deserialization ──────────────────────────────────────────

export const isRouterPersistedState = (
	value: unknown,
): value is RouterPersistedState => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const v = value as Record<string, unknown>;
	return (
		typeof v.enabled === "boolean" &&
		typeof v.selectedProfile === "string" &&
		typeof v.timestamp === "number"
	);
};

// ─── Persistent state file helpers ─────────────────────────────────────────

const loadPersistentState = (): RouterPersistedState | null => {
	try {
		const file = STATE_FILE();
		if (!existsSync(file)) return null;
		const raw = readFileSync(file, "utf-8");
		const data = JSON.parse(raw);
		return isRouterPersistedState(data) ? data : null;
	} catch {
		return null;
	}
};

const savePersistentState = (state: RouterPersistedState): void => {
	try {
		ensureStateDir();
		const file = STATE_FILE();
		writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
	} catch {
		// Silently fail - state will retry on next persist
	}
};

// ─── RouterState class ────────────────────────────────────────────────────────

export class RouterState {
	// ─── Config & environment ────────────────────────────────────────────
	currentConfig: RouterConfig = FALLBACK_CONFIG;
	currentModelRegistry: ExtensionContext["modelRegistry"] | undefined;
	currentCwd = process.cwd();
	lastExtensionContext: ExtensionContext | undefined;

	// ─── Router lifecycle ────────────────────────────────────────────────
	routerEnabled = false;
	selectedProfile: string;
	isInternalModelSwitch = false;

	// ─── Routing state ───────────────────────────────────────────────────
	pinnedTierByProfile: RouterPinByProfile = {};
	thinkingByProfile: RouterThinkingByProfile = {};

	// ─── Session-scoped state (per-session isolation) ───────────────────
	private sessionScopes = new Map<string, SessionScope>();
	activeSessionId: string | undefined;

	// ─── Debug & UI ──────────────────────────────────────────────────────
	debugEnabled = false;
	widgetEnabled = false;

	// ─── Cost & model tracking (shared across scopes for backward compat) ─
	lastNonRouterModel: string | undefined;
	lastRegisteredModels = "";

	// ─── RTK stats (session-level) ──────────────────────────────────────
	/** Number of bash commands rewritten by RTK. */
	rtkRewriteCount = 0;
	/** Whether RTK integration is active (config enabled + binary available). */
	rtkActive = false;
	
	// ─── Frozen TOON compression cache ────────────────────────────────────
	// When freezeAfter is configured, stores the frozen TOON block to reuse
	frozenCompressionBlock?: { messages: Message[]; stats: CompressionStats };

	// ─── Calibration (session-level, ephemeral) ─────────────────────────
	calibration: SessionCalibration | undefined;
	// ─── Auto-upgrade failure tracking (transient, not persisted) ───────
	/** Tracks consecutive failures: toolName → count */
	toolFailureStreak: Map<string, number> = new Map();
	/** When set, forces the next routing decision to use this tier (one-shot). */
	autoUpgradeTier: import("./types").RouterTier | undefined;


	// ─── Update detection (transient, not persisted) ────────────────────
	updateAvailable: { current: string; latest: string } | undefined;
	updateBannerShown = false;
	// ─── Internal ────────────────────────────────────────────────────────
	private lastPersistedSnapshot: string | undefined;
	private readonly pi: ExtensionAPI;

	constructor(pi: ExtensionAPI) {
		this.pi = pi;
		this.selectedProfile = resolveProfileName(
			FALLBACK_CONFIG,
			FALLBACK_CONFIG.defaultProfile,
		);
	}

	// ─── Session scope management ───────────────────────────────────────

	/**
	 * Activate a session scope. Called on session_start/turn_start.
	 * Creates a new scope if one doesn't exist for this session ID.
	 */
	activateSession(sessionId: string, parentSessionId?: string): void {
		this.activeSessionId = sessionId;
		if (!this.sessionScopes.has(sessionId)) {
			this.sessionScopes.set(sessionId, {
				sessionId,
				parentSessionId,
				accumulatedCost: 0,
				accumulatedOriginalTokens: 0,
				accumulatedCompressedTokens: 0,
				accumulatedTokensSaved: 0,
				accumulatedCacheReadTokens: 0,
				compressionRequestCount: 0,
				compressionTotalOriginalChars: 0,
				compressionTotalCompressedChars: 0,
				debugHistory: [],
				lastDecision: undefined,
				isStreaming: false,
				tierCounter: { high: 0, medium: 0, low: 0 },
				modelCosts: new Map(),
			});
		}
	}

	/** Get the active session scope (creates a default if none active). */
	get scope(): SessionScope {
		if (this.activeSessionId) {
			const s = this.sessionScopes.get(this.activeSessionId);
			if (s) return s;
		}
		// Fallback: create an ephemeral scope (should not normally happen)
		const fallbackId = "__default__";
		if (!this.sessionScopes.has(fallbackId)) {
			this.activateSession(fallbackId);
		}
		return this.sessionScopes.get(fallbackId)!;
	}

	/**
	 * Finalize a child session scope and merge its cost into the parent.
	 * Called when a sub-agent completes.
	 */
	finalizeChildSession(childSessionId: string): void {
		const child = this.sessionScopes.get(childSessionId);
		if (!child) return;

		const parentId = child.parentSessionId;
		if (parentId) {
			const parent = this.sessionScopes.get(parentId);
			if (parent) {
				parent.accumulatedCost += child.accumulatedCost;
				parent.accumulatedOriginalTokens += child.accumulatedOriginalTokens;
				parent.accumulatedCompressedTokens += child.accumulatedCompressedTokens;
				parent.accumulatedTokensSaved += child.accumulatedTokensSaved;
				parent.accumulatedCacheReadTokens += child.accumulatedCacheReadTokens;
			}
		}

		// Clean up child scope to free memory
		this.sessionScopes.delete(childSessionId);
	}

	/** Get total cost across all active session scopes. */
	get totalCost(): number {
		let total = 0;
		for (const scope of this.sessionScopes.values()) {
			total += scope.accumulatedCost;
		}
		return total;
	}

	// ─── Backward-compatible accessors (delegate to active scope) ────────

	get accumulatedCost(): number { return this.scope.accumulatedCost; }
	set accumulatedCost(v: number) { this.scope.accumulatedCost = v; }

	get accumulatedOriginalTokens(): number { return this.scope.accumulatedOriginalTokens; }
	set accumulatedOriginalTokens(v: number) { this.scope.accumulatedOriginalTokens = v; }

	get accumulatedCompressedTokens(): number { return this.scope.accumulatedCompressedTokens; }
	set accumulatedCompressedTokens(v: number) { this.scope.accumulatedCompressedTokens = v; }

	get accumulatedTokensSaved(): number { return this.scope.accumulatedTokensSaved; }
	set accumulatedTokensSaved(v: number) { this.scope.accumulatedTokensSaved = v; }

	get accumulatedCacheReadTokens(): number { return this.scope.accumulatedCacheReadTokens; }
	set accumulatedCacheReadTokens(v: number) { this.scope.accumulatedCacheReadTokens = v; }

	get compressionRequestCount(): number { return this.scope.compressionRequestCount; }
	set compressionRequestCount(v: number) { this.scope.compressionRequestCount = v; }

	get compressionTotalOriginalChars(): number { return this.scope.compressionTotalOriginalChars; }
	set compressionTotalOriginalChars(v: number) { this.scope.compressionTotalOriginalChars = v; }

	get compressionTotalCompressedChars(): number { return this.scope.compressionTotalCompressedChars; }
	set compressionTotalCompressedChars(v: number) { this.scope.compressionTotalCompressedChars = v; }

	get debugHistory(): RoutingDecision[] { return this.scope.debugHistory; }
	set debugHistory(v: RoutingDecision[]) { this.scope.debugHistory = v; }

	get lastDecision(): RoutingDecision | undefined { return this.scope.lastDecision; }
	set lastDecision(v: RoutingDecision | undefined) { this.scope.lastDecision = v; }

	get isStreaming(): boolean { return this.scope.isStreaming; }
	set isStreaming(v: boolean) { this.scope.isStreaming = v; }

	get currentCheckpoint(): CompressionCheckpoint | undefined { return this.scope.currentCheckpoint; }
	set currentCheckpoint(v: CompressionCheckpoint | undefined) { this.scope.currentCheckpoint = v; }

	get lastTurnTimestamp(): number | undefined { return this.scope.lastTurnTimestamp; }
	set lastTurnTimestamp(v: number | undefined) { this.scope.lastTurnTimestamp = v; }

	get tierCounter(): TierCounter { return this.scope.tierCounter; }
	get modelCosts(): Map<string, ModelCostEntry> { return this.scope.modelCosts; }

	/** Record a routing decision (tier counter). Called at decision time. */
	recordRoutingDecision(tier: RouterTier): void {
		this.scope.tierCounter[tier]++;
	}

	/** Record model cost on stream completion. Called when usage data arrives. */
	recordModelCost(model: string, tier: string, usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cost: number }): void {
		const existing = this.scope.modelCosts.get(model);
		if (existing) {
			existing.invocations++;
			existing.inputTokens += usage.inputTokens;
			existing.outputTokens += usage.outputTokens;
			existing.cacheReadTokens += usage.cacheReadTokens;
			existing.cacheWriteTokens += usage.cacheWriteTokens;
			existing.cost += usage.cost;
		} else {
			this.scope.modelCosts.set(model, {
				model,
				tier,
				invocations: 1,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cacheReadTokens: usage.cacheReadTokens,
				cacheWriteTokens: usage.cacheWriteTokens,
				cost: usage.cost,
			});
		}
	}

	recordDecision(decision: RoutingDecision): void {
		const limit = this.currentConfig.debugHistoryLimit ?? MAX_DEBUG_HISTORY;
		if (this.debugHistory.length >= limit) this.debugHistory.shift();
		this.debugHistory.push(decision);
	}

	getThinkingOverride(
		profileName: string,
		tier: RouterTier,
	): RoutingDecision["thinking"] | undefined {
		return this.thinkingByProfile[profileName]?.[tier];
	}

	/** Minimum interval between session entry writes (ms) */
	private static readonly PERSIST_DEBOUNCE_MS = 1000;
	private lastPersistTime = 0;
	private pendingPersistTimer: ReturnType<typeof setTimeout> | undefined;

	persist(): void {
		const now = Date.now();
		const elapsed = now - this.lastPersistTime;

		// Debounce: if we persisted less than 1s ago, schedule a deferred write
		if (elapsed < RouterState.PERSIST_DEBOUNCE_MS) {
			if (!this.pendingPersistTimer) {
				this.pendingPersistTimer = setTimeout(() => {
					this.pendingPersistTimer = undefined;
					this.persistNow();
				}, RouterState.PERSIST_DEBOUNCE_MS - elapsed);
			}
			return;
		}

		this.persistNow();
	}

	private persistNow(): void {
		const state = this.buildPersistedState();
		const snapshot = JSON.stringify({
			...state,
			timestamp: 0,
			lastDecision: state.lastDecision
				? { ...state.lastDecision, timestamp: 0 }
				: undefined,
			debugHistory: state.debugHistory?.map((d) => ({
				...d,
				timestamp: 0,
			})),
		});
		if (snapshot === this.lastPersistedSnapshot) return;

		this.lastPersistTime = Date.now();

		// Save to persistent file (survives session restart)
		savePersistentState(state);

		// Also save to session for intra-session restoration
		try {
			this.pi.appendEntry("router-state", state);
		} catch {
			// Runtime not yet initialized (e.g. memory startup fires before
			// extensionRunner.initialize wires the real appendEntry). Skip
			// silently — state will persist on the next successful call.
			return;
		}
		this.lastPersistedSnapshot = snapshot;
	}

	restoreFromSession(ctx: ExtensionContext): void {
		this.lastExtensionContext = ctx;
		this.currentModelRegistry = ctx.modelRegistry;
		this.currentCwd = ctx.cwd;

		// ─── Source of truth for enabled/profile is the config file ─────
		this.routerEnabled = this.currentConfig.routerEnabled ?? false;
		this.selectedProfile = resolveProfileName(
			this.currentConfig,
			this.currentConfig.defaultProfile,
		);

		// ─── Reset session-scoped state ─────────────────────────────────
		this.pinnedTierByProfile = {};
		this.thinkingByProfile = {};
		this.widgetEnabled = false;
		this.debugHistory = [];
		this.accumulatedCost = 0;
		this.accumulatedOriginalTokens = 0;
		this.accumulatedCompressedTokens = 0;
		this.accumulatedTokensSaved = 0;
		this.accumulatedCacheReadTokens = 0;
		this.lastNonRouterModel =
			ctx.model && ctx.model.provider !== "router"
				? `${ctx.model.provider}/${ctx.model.id}`
				: this.lastNonRouterModel;
		this.lastDecision = undefined;

		// ─── Restore session-level preferences from saved state ─────────
		// (pins, thinking overrides, widget, debug history, cost, etc.)
		const persistedState = loadPersistentState();

		const entries = ctx.sessionManager.getBranch() as CustomSessionEntry[];
		const sessionState = entries
			.filter(
				(entry) =>
					entry.type === "custom" && entry.customType === "router-state",
			)
			.map((entry) => entry.data)
			.reduce<RouterPersistedState | null>(
				(acc, data) => (isRouterPersistedState(data) ? data : acc),
				null,
			);

		const savedState = sessionState ?? persistedState;

		if (isRouterPersistedState(savedState)) {
			// Do NOT restore enabled/selectedProfile from state — config is authoritative
			this.pinnedTierByProfile = savedState.pinByProfile
				? { ...savedState.pinByProfile }
				: {};
			this.thinkingByProfile = savedState.thinkingByProfile
				? { ...savedState.thinkingByProfile }
				: {};
			if (savedState.pinTier) {
				this.pinnedTierByProfile[this.selectedProfile] = savedState.pinTier;
			}
			this.debugEnabled = savedState.debugEnabled ?? this.debugEnabled;
			this.widgetEnabled = savedState.widgetEnabled ?? this.widgetEnabled;
			// debugHistory is session-scoped and NOT restored — usage ledger is
			// the authoritative source for /router usage. debugHistory only shows
			// the last N routing decisions for debugging purposes.
			this.lastNonRouterModel =
				savedState.lastNonRouterModel ?? this.lastNonRouterModel;
			// Accumulated metrics (cost, tokens, cache) are session-scoped and
			// intentionally NOT restored from persisted state. They always start at 0
			// for each new session to accurately reflect the current session's usage.
		}
	}

	private buildPersistedState(): RouterPersistedState {
		return {
			enabled: this.routerEnabled,
			selectedProfile: this.selectedProfile,
			pinTier: this.pinnedTierByProfile[this.selectedProfile],
			pinByProfile: { ...this.pinnedTierByProfile },
			thinkingByProfile: { ...this.thinkingByProfile },
			debugEnabled: this.debugEnabled,
			widgetEnabled: this.widgetEnabled,
			debugHistory: this.debugHistory,
			lastPhase: this.lastDecision?.phase,
			lastDecision: this.lastDecision,
			lastNonRouterModel: this.lastNonRouterModel,
			accumulatedCost: this.accumulatedCost,
			accumulatedOriginalTokens: this.accumulatedOriginalTokens,
			accumulatedCompressedTokens: this.accumulatedCompressedTokens,
			accumulatedTokensSaved: this.accumulatedTokensSaved,
			accumulatedCacheReadTokens: this.accumulatedCacheReadTokens,
			timestamp: Date.now(),
		};
	}
}
