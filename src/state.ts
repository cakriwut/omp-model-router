import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
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
	isStreaming = false;

	// ─── Routing state ───────────────────────────────────────────────────
	lastDecision: RoutingDecision | undefined;
	pinnedTierByProfile: RouterPinByProfile = {};
	thinkingByProfile: RouterThinkingByProfile = {};

	// ─── Debug & UI ──────────────────────────────────────────────────────
	debugEnabled = false;
	widgetEnabled = false;
	debugHistory: RoutingDecision[] = [];

	// ─── Cost & model tracking ───────────────────────────────────────────
	accumulatedCost = 0;
	accumulatedOriginalTokens = 0;
	accumulatedCompressedTokens = 0;
	accumulatedTokensSaved = 0;
	accumulatedCacheReadTokens = 0;
	lastNonRouterModel: string | undefined;
	lastRegisteredModels = "";

	// ─── Compression stats (session-level) ──────────────────────────────
	compressionRequestCount = 0;
	compressionTotalOriginalChars = 0;
	compressionTotalCompressedChars = 0;
	
	// ─── Frozen TOON compression cache ────────────────────────────────────
	// When freezeAfter is configured, stores the frozen TOON block to reuse
	frozenCompressionBlock?: { messages: Message[]; stats: CompressionStats };

	// ─── Progressive TOON checkpoint ────────────────────────────────────
	/** Current checkpoint (frozen TOON block + metadata) used in progressive mode. */
	currentCheckpoint?: CompressionCheckpoint;
	/** Timestamp of the last turn processed (epoch ms). Used for cache expiry detection. */
	lastTurnTimestamp?: number;
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

	recordDecision(decision: RoutingDecision): void {
		const limit = this.currentConfig.debugHistoryLimit ?? MAX_DEBUG_HISTORY;
		this.debugHistory = [...this.debugHistory, decision].slice(-limit);
	}

	getThinkingOverride(
		profileName: string,
		tier: RouterTier,
	): RoutingDecision["thinking"] | undefined {
		return this.thinkingByProfile[profileName]?.[tier];
	}

	persist(): void {
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
			this.debugHistory = savedState.debugHistory
				? [...savedState.debugHistory].slice(-(this.currentConfig.debugHistoryLimit ?? MAX_DEBUG_HISTORY))
				: [];
			this.lastNonRouterModel =
				savedState.lastNonRouterModel ?? this.lastNonRouterModel;
		this.accumulatedCost = savedState.accumulatedCost ?? 0;
		this.accumulatedOriginalTokens = savedState.accumulatedOriginalTokens ?? 0;
		this.accumulatedCompressedTokens = savedState.accumulatedCompressedTokens ?? 0;
		this.accumulatedTokensSaved = savedState.accumulatedTokensSaved ?? 0;
		this.accumulatedCacheReadTokens = savedState.accumulatedCacheReadTokens ?? 0;
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
