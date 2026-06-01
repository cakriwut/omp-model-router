import type { SessionCalibration } from "../calibration/types";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	RouterConfig,
	RouterPinByProfile,
	RouterThinkingByProfile,
	RouterTier,
	RoutingDecision,
	CustomSessionEntry,
	CompressionStats,
	CompressionCheckpoint,
} from "../types";
import type { Message } from "@oh-my-pi/pi-ai";
import { FALLBACK_CONFIG, resolveProfileName } from "../config";
import { MAX_DEBUG_HISTORY } from "../constants";
import { persist, restoreFromSession, buildPersistedState } from "./persist";

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
	private parentAttributionLogged = new Set<string>();

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
	autoUpgradeTier: RouterTier | undefined;

	// ─── Update detection (transient, not persisted) ────────────────────
	updateAvailable: { current: string; latest: string } | undefined;
	updateBannerShown = false;

	// ─── Internal (debounce + persistence state) ────────────────────────
	lastPersistedSnapshot: string | undefined;
	lastPersistTime = 0;
	pendingPersistTimer: ReturnType<typeof setTimeout> | undefined;
	readonly pi: ExtensionAPI;

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
	 *
	 * Late-binding rule: the **first non-undefined** `parentSessionId` observed
	 * for a given `sessionId` wins. A subsequent call with a defined parent
	 * will populate the field only if the existing scope's parent is still
	 * `undefined`; it NEVER overwrites a parent that was already set.
	 *
	 * Callers SHOULD pass the parent from the harness's authoritative source:
	 * `ctx.sessionManager.getHeader()?.parentSession`. Do not infer parents
	 * from heuristics — pass `undefined` if the header is not available and
	 * rely on a later activation to late-bind.
	 *
	 * The optional `source` argument is used only for debug-log attribution
	 * (gated on `config.debug`) and has no functional effect.
	 *
	 * @param sessionId       The session being activated.
	 * @param parentSessionId Parent session id from `SessionHeader.parentSession`, if known.
	 * @param source          Provenance of `parentSessionId` for diagnostics: "header" |
	 *                        "fallback" | "none". Defaults to "none".
	 */
	activateSession(
		sessionId: string,
		parentSessionId?: string,
		source: "header" | "fallback" | "none" = "none",
	): void {
		this.activeSessionId = sessionId;
		const existing = this.sessionScopes.get(sessionId);
		if (!existing) {
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
			if (this.currentConfig.debug && !this.parentAttributionLogged.has(sessionId)) {
				this.parentAttributionLogged.add(sessionId);
				if (parentSessionId !== undefined && source === "header") {
					console.log(
						`[model-router] parent attribution: child=${sessionId} source=header parent=${parentSessionId}`,
					);
				} else if (parentSessionId !== undefined && source === "fallback") {
					console.log(
						`[model-router] parent attribution: child=${sessionId} source=fallback parent=${parentSessionId}`,
					);
				} else {
					console.log(
						`[model-router] parent attribution: child=${sessionId} source=none (root or orphan)`,
					);
				}
			}
		} else {
			this.setParentIfAbsent(existing, parentSessionId, sessionId);
		}
	}

	/**
	 * Late-bind a parent session id on an existing scope. Only assigns when the
	 * scope's current `parentSessionId` is `undefined` and the incoming value
	 * is defined — first non-undefined parent wins.
	 */
	private setParentIfAbsent(
		scope: SessionScope,
		parentSessionId: string | undefined,
		sessionId: string,
	): void {
		if (scope.parentSessionId === undefined && parentSessionId !== undefined) {
			scope.parentSessionId = parentSessionId;
			if (this.currentConfig.debug) {
				console.log(
					`[model-router] late-bound parent for ${sessionId}: ${parentSessionId}`,
				);
			}
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
	 * Finalize a child session scope and roll up its accumulated cost/token
	 * counters into the parent scope.
	 *
	 * Behavior:
	 * - If `child.parentSessionId` is set AND the parent scope still exists,
	 *   the child's cost and token counters are added to the parent.
	 * - If `child.parentSessionId` is `undefined`, the scope is deleted
	 *   WITHOUT any rollup — the child's cost is effectively dropped. This is
	 *   the dominant symptom when parent attribution fails upstream.
	 * - The child scope is always deleted to free memory.
	 *
	 * To diagnose missing rollups, enable `config.debug` and inspect the
	 * `[model-router] parent attribution:` and `[model-router] late-bound
	 * parent for ...` logs emitted by {@link activateSession}.
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

	persist(): void {
		persist(this);
	}

	restoreFromSession(ctx: ExtensionContext): void {
		restoreFromSession(this, ctx);
	}
}

// Re-exports from persist module
export { buildPersistedState, isRouterPersistedState } from "./persist";
