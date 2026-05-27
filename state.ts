import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	RouterConfig,
	RouterPinByProfile,
	RouterThinkingByProfile,
	RouterTier,
	RoutingDecision,
	RouterPersistedState,
	CustomSessionEntry,
} from "./types";
import { FALLBACK_CONFIG, resolveProfileName } from "./config";
import { MAX_DEBUG_HISTORY } from "./constants";

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
	lastNonRouterModel: string | undefined;
	lastRegisteredModels = "";

	// ─── Compression stats (session-level) ──────────────────────────────
	compressionRequestCount = 0;
	compressionTotalOriginalChars = 0;
	compressionTotalCompressedChars = 0;

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
		this.debugHistory = [...this.debugHistory, decision].slice(-MAX_DEBUG_HISTORY);
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

		this.routerEnabled = ctx.model?.provider === "router";
		this.selectedProfile = resolveProfileName(
			this.currentConfig,
			ctx.model?.provider === "router" ? ctx.model.id : this.selectedProfile,
		);
		this.pinnedTierByProfile = {};
		this.thinkingByProfile = {};
		this.widgetEnabled = false;
		this.debugHistory = [];
		this.accumulatedCost = 0;
		this.lastNonRouterModel =
			ctx.model && ctx.model.provider !== "router"
				? `${ctx.model.provider}/${ctx.model.id}`
				: this.lastNonRouterModel;
		this.lastDecision = undefined;

		const entries = ctx.sessionManager.getBranch() as CustomSessionEntry[];
		const savedState = entries
			.filter(
				(entry) =>
					entry.type === "custom" && entry.customType === "router-state",
			)
			.map((entry) => entry.data)
			.findLast((data) => isRouterPersistedState(data));

		if (isRouterPersistedState(savedState)) {
			this.selectedProfile = resolveProfileName(
				this.currentConfig,
				savedState.selectedProfile,
			);
			this.routerEnabled = savedState.enabled;
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
				? [...savedState.debugHistory].slice(-MAX_DEBUG_HISTORY)
				: [];
			this.lastNonRouterModel =
				savedState.lastNonRouterModel ?? this.lastNonRouterModel;
			this.accumulatedCost = savedState.accumulatedCost ?? 0;
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
			timestamp: Date.now(),
		};
	}
}
