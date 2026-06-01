import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { existsSync, unlinkSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the embargo methods by importing RouterState and mocking minimally
// Since RouterState needs an ExtensionAPI, we'll create a minimal mock

const createMockPi = () => ({
	setLabel: () => {},
	registerProvider: () => {},
	registerCommand: () => {},
	on: () => {},
	setModel: async () => true,
});

// We need to test the embargo logic in isolation, so we import the state module
import { RouterState } from "../src/state/index";

describe("RouterState embargo methods", () => {
	let state: RouterState;

	beforeEach(() => {
		state = new RouterState(createMockPi() as any);
		state.currentConfig = {
			...state.currentConfig,
			embargo: {
				enabled: true,
				defaultCooldownMs: 60_000,
				minCooldownMs: 5_000,
				maxCooldownMs: 3_600_000,
			},
		};
	});

	test("embargoModel sets entry in map", () => {
		state.embargoModel("anthropic/claude-sonnet", 429, "Rate limited", 60_000);
		expect(state.embargoMap.has("anthropic/claude-sonnet")).toBe(true);
		const entry = state.embargoMap.get("anthropic/claude-sonnet")!;
		expect(entry.status).toBe(429);
		expect(entry.reason).toBe("Rate limited");
		expect(entry.effectiveDurationMs).toBe(60_000);
		expect(entry.expiresAt).toBeGreaterThan(Date.now());
	});

	test("embargoModel stores requestedDurationMs", () => {
		state.embargoModel("anthropic/claude-sonnet", 429, "Rate limited", 3_600_000, 14_400_000);
		const entry = state.embargoMap.get("anthropic/claude-sonnet")!;
		expect(entry.requestedDurationMs).toBe(14_400_000);
		expect(entry.effectiveDurationMs).toBe(3_600_000);
	});

	test("isEmbargoed returns true for active embargo", () => {
		state.embargoModel("anthropic/claude-sonnet", 429, "Rate limited", 60_000);
		expect(state.isEmbargoed("anthropic/claude-sonnet")).toBe(true);
	});

	test("isEmbargoed returns false for non-existent model", () => {
		expect(state.isEmbargoed("openai/gpt-4")).toBe(false);
	});

	test("isEmbargoed returns false and cleans up expired entry", () => {
		// Set embargo that expired in the past
		state.embargoMap.set("anthropic/claude-sonnet", {
			modelRef: "anthropic/claude-sonnet",
			expiresAt: Date.now() - 1000,
			embargoedAt: Date.now() - 61_000,
			status: 429,
			reason: "Rate limited",
			effectiveDurationMs: 60_000,
		});
		expect(state.isEmbargoed("anthropic/claude-sonnet")).toBe(false);
		expect(state.embargoMap.has("anthropic/claude-sonnet")).toBe(false);
	});

	test("getEmbargoTimeRemaining returns positive ms for active embargo", () => {
		state.embargoModel("anthropic/claude-sonnet", 429, "Rate limited", 60_000);
		const remaining = state.getEmbargoTimeRemaining("anthropic/claude-sonnet");
		expect(remaining).toBeGreaterThan(0);
		expect(remaining).toBeLessThanOrEqual(60_000);
	});

	test("getEmbargoTimeRemaining returns 0 for non-embargoed model", () => {
		expect(state.getEmbargoTimeRemaining("openai/gpt-4")).toBe(0);
	});

	test("liftEmbargo removes entry", () => {
		state.embargoModel("anthropic/claude-sonnet", 429, "Rate limited", 60_000);
		state.liftEmbargo("anthropic/claude-sonnet");
		expect(state.isEmbargoed("anthropic/claude-sonnet")).toBe(false);
		expect(state.embargoMap.has("anthropic/claude-sonnet")).toBe(false);
	});

	test("liftEmbargo is no-op for non-existent model", () => {
		// Should not throw
		state.liftEmbargo("non-existent/model");
	});

	test("getActiveEmbargoes returns only non-expired entries", () => {
		state.embargoModel("model-a", 429, "Rate limited", 60_000);
		state.embargoModel("model-b", 503, "Unavailable", 30_000);
		// Add an expired one manually
		state.embargoMap.set("model-c", {
			modelRef: "model-c",
			expiresAt: Date.now() - 1000,
			embargoedAt: Date.now() - 61_000,
			status: 429,
			reason: "Expired",
			effectiveDurationMs: 60_000,
		});

		const active = state.getActiveEmbargoes();
		expect(active.length).toBe(2);
		expect(active.map((e) => e.modelRef).sort()).toEqual(["model-a", "model-b"]);
		// Expired entry should have been cleaned
		expect(state.embargoMap.has("model-c")).toBe(false);
	});

	test("clearAllEmbargoes removes all entries", () => {
		state.embargoModel("model-a", 429, "Rate limited", 60_000);
		state.embargoModel("model-b", 503, "Unavailable", 30_000);
		state.clearAllEmbargoes();
		expect(state.embargoMap.size).toBe(0);
		expect(state.getActiveEmbargoes().length).toBe(0);
	});

	test("getSoonestExpiry returns model with earliest expiry", () => {
		const now = Date.now();
		state.embargoMap.set("model-a", {
			modelRef: "model-a",
			expiresAt: now + 120_000,
			embargoedAt: now,
			status: 429,
			reason: "Rate limited",
			effectiveDurationMs: 120_000,
		});
		state.embargoMap.set("model-b", {
			modelRef: "model-b",
			expiresAt: now + 30_000,
			embargoedAt: now,
			status: 503,
			reason: "Unavailable",
			effectiveDurationMs: 30_000,
		});
		state.embargoMap.set("model-c", {
			modelRef: "model-c",
			expiresAt: now + 90_000,
			embargoedAt: now,
			status: 529,
			reason: "Overloaded",
			effectiveDurationMs: 90_000,
		});

		expect(state.getSoonestExpiry(["model-a", "model-b", "model-c"])).toBe("model-b");
	});

	test("getSoonestExpiry returns undefined for empty list", () => {
		expect(state.getSoonestExpiry([])).toBeUndefined();
	});

	test("getSoonestExpiry returns undefined when no models are embargoed", () => {
		expect(state.getSoonestExpiry(["model-a", "model-b"])).toBeUndefined();
	});
});

// ─── Persistence tests ───────────────────────────────────────────────────────

describe("Embargo persistence", () => {
	const testDir = join(tmpdir(), `embargo-test-${Date.now()}`);
	const testFile = join(testDir, "model-router-embargo.json");

	beforeEach(() => {
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		try {
			if (existsSync(testFile)) unlinkSync(testFile);
		} catch {}
	});

	test("persistEmbargo writes valid JSON", async () => {
		const state = new RouterState(createMockPi() as any);
		// Override embargoDir to use temp
		Object.defineProperty(state, "embargoDir", { get: () => testDir });
		Object.defineProperty(state, "embargoFilePath", { get: () => testFile });

		state.embargoModel("anthropic/claude-sonnet", 429, "Rate limited", 60_000);

		// Wait for debounce
		await new Promise((r) => setTimeout(r, 200));

		expect(existsSync(testFile)).toBe(true);
		const data = JSON.parse(readFileSync(testFile, "utf-8"));
		expect(data["anthropic/claude-sonnet"]).toBeDefined();
		expect(data["anthropic/claude-sonnet"].status).toBe(429);
		expect(data["anthropic/claude-sonnet"].expiresAt).toBeGreaterThan(Date.now());
	});

	test("restoreEmbargo reads valid entries from file", () => {
		const now = Date.now();
		const fileData = {
			"model-a": {
				modelRef: "model-a",
				expiresAt: now + 60_000,
				embargoedAt: now - 10_000,
				status: 429,
				reason: "Rate limited",
				effectiveDurationMs: 60_000,
			},
			"model-b": {
				modelRef: "model-b",
				expiresAt: now - 5_000, // expired
				embargoedAt: now - 65_000,
				status: 503,
				reason: "Unavailable",
				effectiveDurationMs: 60_000,
			},
		};
		mkdirSync(testDir, { recursive: true });
		const { writeFileSync: wfs } = require("node:fs");
		wfs(testFile, JSON.stringify(fileData));

		const state = new RouterState(createMockPi() as any);
		Object.defineProperty(state, "embargoDir", { get: () => testDir });
		Object.defineProperty(state, "embargoFilePath", { get: () => testFile });

		state.restoreEmbargo();

		// model-a should be restored (not expired)
		expect(state.isEmbargoed("model-a")).toBe(true);
		// model-b should be discarded (expired)
		expect(state.isEmbargoed("model-b")).toBe(false);
	});

	test("restoreEmbargo handles missing file gracefully", () => {
		const state = new RouterState(createMockPi() as any);
		Object.defineProperty(state, "embargoDir", { get: () => testDir });
		Object.defineProperty(state, "embargoFilePath", {
			get: () => join(testDir, "nonexistent.json"),
		});

		// Should not throw
		state.restoreEmbargo();
		expect(state.embargoMap.size).toBe(0);
	});

	test("restoreEmbargo handles corrupt file gracefully", () => {
		const corruptFile = join(testDir, "corrupt.json");
		const { writeFileSync: wfs } = require("node:fs");
		wfs(corruptFile, "not valid json {{{");

		const state = new RouterState(createMockPi() as any);
		Object.defineProperty(state, "embargoDir", { get: () => testDir });
		Object.defineProperty(state, "embargoFilePath", { get: () => corruptFile });

		// Should not throw
		state.restoreEmbargo();
		expect(state.embargoMap.size).toBe(0);
	});
});
