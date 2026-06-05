import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type {
	RouterPersistedState,
	CustomSessionEntry,
} from "../types";
import { resolveProfileName } from "../config";
import type { RouterState } from "./index";

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
		const dir = join(getAgentDir(), "model-router");
		const file = join(dir, "router-state.json");
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
		const dir = join(getAgentDir(), "model-router");
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const file = join(dir, "router-state.json");
		writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
	} catch {
		// Silently fail - state will retry on next persist
	}
};

// ─── Persistence logic ─────────────────────────────────────────────────────

/** Minimum interval between session entry writes (ms) */
export const PERSIST_DEBOUNCE_MS = 1000;

export const buildPersistedState = (
	state: RouterState,
): RouterPersistedState => ({
	enabled: state.routerEnabled,
	selectedProfile: state.selectedProfile,
	thinkingByProfile: { ...state.thinkingByProfile },
	debugEnabled: state.debugEnabled,
	widgetEnabled: state.widgetEnabled,
	debugHistory: state.debugHistory,
	lastPhase: state.lastDecision?.phase,
	lastDecision: state.lastDecision,
	lastNonRouterModel: state.lastNonRouterModel,
	accumulatedCost: state.accumulatedCost,
	timestamp: Date.now(),
});

const persistNow = (state: RouterState): void => {
	const persisted = buildPersistedState(state);
	const snapshot = JSON.stringify({
		...persisted,
		timestamp: 0,
		lastDecision: persisted.lastDecision
			? { ...persisted.lastDecision, timestamp: 0 }
			: undefined,
		debugHistory: persisted.debugHistory?.map((d) => ({
			...d,
			timestamp: 0,
		})),
	});
	if (snapshot === state.lastPersistedSnapshot) return;

	state.lastPersistTime = Date.now();

	// Save to persistent file (survives session restart)
	savePersistentState(persisted);

	// Also save to session for intra-session restoration
	try {
		state.pi.appendEntry("router-state", persisted);
	} catch {
		// Runtime not yet initialized (e.g. memory startup fires before
		// extensionRunner.initialize wires the real appendEntry). Skip
		// silently — state will persist on the next successful call.
		return;
	}
	state.lastPersistedSnapshot = snapshot;
};

export const persist = (state: RouterState): void => {
	const now = Date.now();
	const elapsed = now - state.lastPersistTime;

	// Debounce: if we persisted less than 1s ago, schedule a deferred write
	if (elapsed < PERSIST_DEBOUNCE_MS) {
		if (!state.pendingPersistTimer) {
			state.pendingPersistTimer = setTimeout(() => {
				state.pendingPersistTimer = undefined;
				persistNow(state);
			}, PERSIST_DEBOUNCE_MS - elapsed);
		}
		return;
	}

	persistNow(state);
};

export const restoreFromSession = (
	state: RouterState,
	ctx: ExtensionContext,
): void => {
	state.lastExtensionContext = ctx;
	state.currentModelRegistry = ctx.modelRegistry;
	state.currentCwd = ctx.cwd;

	// ─── Source of truth for enabled/profile is the config file ─────
	state.routerEnabled = state.currentConfig.routerEnabled ?? false;
	state.selectedProfile = resolveProfileName(
		state.currentConfig,
		state.currentConfig.defaultProfile,
	);

	// ─── Reset session-scoped state ─────────────────────────────────
	state.thinkingByProfile = {};
	state.widgetEnabled = false;
	state.debugHistory = [];
	// NOTE: Do NOT reset accumulatedCost, tierCounter, modelCosts here.
	// These are session-scoped metrics that persist across /reload.
	// They are only zero-initialized when activateSession() creates a NEW scope.
	state.lastNonRouterModel =
		ctx.model && ctx.model.provider !== "router"
			? `${ctx.model.provider}/${ctx.model.id}`
			: state.lastNonRouterModel;
	state.lastDecision = undefined;

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
		// Pins are NO LONGER persisted — scoped pins are memory-only and session-scoped.
		state.thinkingByProfile = savedState.thinkingByProfile
			? { ...savedState.thinkingByProfile }
			: {};
		state.debugEnabled = savedState.debugEnabled ?? state.debugEnabled;
		state.widgetEnabled = savedState.widgetEnabled ?? state.widgetEnabled;
		// debugHistory is session-scoped and NOT restored — usage ledger is
		// the authoritative source for /router usage. debugHistory only shows
		// the last N routing decisions for debugging purposes.
		state.lastNonRouterModel =
			savedState.lastNonRouterModel ?? state.lastNonRouterModel;
		// Accumulated metrics (cost, tokens, cache) are session-scoped and
		// intentionally NOT restored from persisted state. They always start at 0
		// for each new session to accurately reflect the current session's usage.
	}
};
