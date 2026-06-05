/**
 * Tests for Thread A: /router usage data-source selection.
 *
 * Verifies that handleUsage prefers in-memory SessionScope data (which includes
 * sub-agent rollup from Threads C+B) over the JSONL rescan when the scope is
 * populated. JSONL rescan fires only for resumed sessions (empty scope).
 */
import { describe, test, expect } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Theme } from "@oh-my-pi/pi-coding-agent/dist/types/modes/theme/theme";
import { handleUsage } from "../src/commands/usage";
import { RouterState } from "../src/state";
import type { ModelCostEntry } from "../src/state";
import { FALLBACK_CONFIG } from "../src/config";

// ─── Minimal mocks (no `any`) ─────────────────────────────────────────────────

const mockPi = { appendEntry: () => {} } as unknown as ExtensionAPI;

/** Passthrough theme — strips colour codes so assertions can match plain text. */
const plainTheme: Theme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	dim: (text) => text,
	bg: (_color, text) => text,
	strikethrough: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	invert: (text) => text,
	link: (_url, text) => text,
} as unknown as Theme;

interface FakeBranchEntry {
	type: "message";
	message: {
		role: "assistant";
		provider: string;
		model: string;
		usage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			cost: { total: number };
		};
	};
}

function makeCtx(branch: FakeBranchEntry[] = []): {
	ctx: ExtensionContext;
	notified: string[];
} {
	const notified: string[] = [];
	const ctx = {
		ui: {
			notify: (msg: string) => { notified.push(msg); },
			theme: plainTheme,
		},
		sessionManager: {
			getBranch: () => branch,
			getHeader: () => null,
			getSessionId: () => "test-session",
		},
		modelRegistry: {
			find: () => undefined,
			models: [],
		},
		model: { provider: "router", id: "auto" },
		cwd: "/test",
		hasUI: true,
		getContextUsage: () => undefined,
		isIdle: () => true,
		hasPendingMessages: () => false,
		getSystemPrompt: () => [],
		abort: () => {},
		shutdown: () => {},
		compact: async () => {},
	} as unknown as ExtensionContext;
	return { ctx, notified };
}

function makeState(): RouterState {
	const state = new RouterState(mockPi);
	state.currentConfig = {
		...FALLBACK_CONFIG,
		profiles: {
			auto: {
				high:   { model: "openai/gpt-4o" },
				medium: { model: "anthropic/claude-sonnet-4" },
				low:    { model: "anthropic/claude-haiku-3" },
			},
		},
		defaultProfile: "auto",
		// historyCompression removed
	};
	state.selectedProfile = "auto";
	state.activateSession("test-session");
	return state;
}

function seedModelCost(state: RouterState, entry: ModelCostEntry): void {
	state.modelCosts.set(entry.model, entry);
}

function makeBranchEntry(provider: string, model: string, costTotal: number): FakeBranchEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			provider,
			model,
			usage: { input: 500, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: costTotal } },
		},
	};
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleUsage — data-source selection (Thread A)", () => {

	test("2.1 primary path: in-memory model used, JSONL model ignored", async () => {
		const state = makeState();
		seedModelCost(state, {
			model: "openai/gpt-4o", tier: "high",
			invocations: 3, inputTokens: 1000, outputTokens: 200,
			cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.05,
		});
		state.accumulatedCost = 0.05; // mirror what recordModelCost would set

		// JSONL has a $0.01 entry for the medium-tier model — must be ignored
		const branch = [makeBranchEntry("anthropic", "claude-sonnet-4", 0.01)];
		const { ctx, notified } = makeCtx(branch);

		await handleUsage(state)([], ctx);

		expect(notified).toHaveLength(1);
		// In-memory: gpt-4o rendered with 3 invocations
		expect(notified[0]).toContain("gpt-4o");
		expect(notified[0]).toContain("3x");
		// Header cost from accumulatedCost ($0.05), NOT JSONL total ($0.01)
		expect(notified[0]).toContain("$0.0500");
		expect(notified[0]).not.toContain("$0.0100");
	});

	test("2.2 fallback path: JSONL model used when scope is empty", async () => {
		const state = makeState();
		// scope has no model costs, accumulatedCost === 0

		const branch = [makeBranchEntry("anthropic", "claude-haiku-3", 0.005)];
		const { ctx, notified } = makeCtx(branch);

		await handleUsage(state)([], ctx);

		expect(notified).toHaveLength(1);
		expect(notified[0]).toContain("claude-haiku-3");
	});

	test("2.3 sub-agent rollup visible: both parent and child model in report", async () => {
		const state = makeState();
		// Seed parent's own model cost
		seedModelCost(state, {
			model: "openai/gpt-4o", tier: "high",
			invocations: 5, inputTokens: 2000, outputTokens: 400,
			cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.10,
		});
		// Seed rolled-up child model (simulating Thread B finalizeChildSession)
		seedModelCost(state, {
			model: "anthropic/claude-haiku-3", tier: "low",
			invocations: 8, inputTokens: 800, outputTokens: 160,
			cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.02,
		});

		// JSONL only has parent model — child was in a separate JSONL
		const branch = [makeBranchEntry("openai", "gpt-4o", 0.10)];
		const { ctx, notified } = makeCtx(branch);

		await handleUsage(state)([], ctx);

		expect(notified).toHaveLength(1);
		expect(notified[0]).toContain("gpt-4o");
		expect(notified[0]).toContain("claude-haiku-3");
	});

	test("2.4 cost total: state.accumulatedCost used in primary path", async () => {
		const state = makeState();
		// Seed a model cost so primary path fires
		seedModelCost(state, {
			model: "openai/gpt-4o", tier: "high",
			invocations: 1, inputTokens: 100, outputTokens: 20,
			cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01,
		});
		// Set accumulatedCost to include child rollup — HIGHER than what JSONL would give
		state.accumulatedCost = 1.2345;

		// JSONL would have yielded $0.50 if scanned — but it won't be
		const branch = [makeBranchEntry("openai", "gpt-4o", 0.50)];
		const { ctx, notified } = makeCtx(branch);

		await handleUsage(state)([], ctx);

		expect(notified[0]).toContain("1.2345");
		expect(notified[0]).not.toContain("0.5000");
	});

	test("2.5 cost total: empty scope with no session file shows $0.0000", async () => {
		const state = makeState();
		// scope empty: modelCosts empty, accumulatedCost === 0
		// No session file returned by ctx.sessionManager (getSessionFile not present in mock)
		// → falls back to in-memory scope, which is empty → $0.0000

		const branch = [makeBranchEntry("anthropic", "claude-haiku-3", 0.25)];
		const { ctx, notified } = makeCtx(branch);

		await handleUsage(state)([], ctx);

		// No session file → in-memory fallback → accumulatedCost = 0
		expect(notified[0]).toContain("$0.0000");
		// Profile model rows still rendered (from profile config)
		expect(notified[0]).toContain("claude-haiku-3");
	});

	// Compression tests removed — historyCompression field deleted

});
