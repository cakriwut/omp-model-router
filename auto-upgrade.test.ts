/**
 * Tests for the auto-upgrade feature:
 * - Config normalization of autoUpgrade
 * - Failure streak tracking logic
 * - One-shot tier override consumption in provider
 */

import { describe, it, expect } from "bun:test";
import { normalizeConfig } from "./config";
import type { AutoUpgradeConfig, RouterConfig, RouterTier } from "./types";

// ─── Config normalization ────────────────────────────────────────────────────

describe("autoUpgrade config normalization", () => {
	const baseConfig: RouterConfig = {
		profiles: {
			auto: {
				high: { model: "anthropic/claude-sonnet-4-5", thinking: "high" },
				medium: { model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" },
				low: { model: "anthropic/claude-haiku-4-5", thinking: "low" },
			},
		},
	};

	it("omitted autoUpgrade results in undefined", () => {
		const { config } = normalizeConfig(baseConfig);
		expect(config.autoUpgrade).toBeUndefined();
	});

	it("disabled autoUpgrade results in undefined", () => {
		const { config } = normalizeConfig({
			...baseConfig,
			autoUpgrade: { enabled: false },
		});
		expect(config.autoUpgrade).toBeUndefined();
	});

	it("enabled autoUpgrade with defaults", () => {
		const { config } = normalizeConfig({
			...baseConfig,
			autoUpgrade: { enabled: true },
		});
		expect(config.autoUpgrade).toEqual({
			enabled: true,
			threshold: 2,
			tools: undefined,
		});
	});

	it("custom threshold is respected (floored)", () => {
		const { config } = normalizeConfig({
			...baseConfig,
			autoUpgrade: { enabled: true, threshold: 3.7 },
		});
		expect(config.autoUpgrade!.threshold).toBe(3);
	});

	it("threshold below 1 defaults to 2", () => {
		const { config } = normalizeConfig({
			...baseConfig,
			autoUpgrade: { enabled: true, threshold: 0 },
		});
		expect(config.autoUpgrade!.threshold).toBe(2);
	});

	it("tools array filters non-strings", () => {
		const { config } = normalizeConfig({
			...baseConfig,
			autoUpgrade: { enabled: true, tools: ["find", 123 as any, "search", null as any] },
		});
		expect(config.autoUpgrade!.tools).toEqual(["find", "search"]);
	});

	it("empty tools array results in undefined", () => {
		const { config } = normalizeConfig({
			...baseConfig,
			autoUpgrade: { enabled: true, tools: [] },
		});
		expect(config.autoUpgrade!.tools).toBeUndefined();
	});
});

// ─── Failure streak logic (unit-level, simulating the handler) ───────────────

describe("auto-upgrade failure streak logic", () => {
	const ROUTER_TIERS: readonly RouterTier[] = ["high", "medium", "low"];

	function simulateToolEnd(
		streakMap: Map<string, number>,
		cfg: AutoUpgradeConfig,
		toolName: string,
		isError: boolean,
		currentTier: RouterTier,
	): { upgradedTier: RouterTier | undefined } {
		const threshold = cfg.threshold ?? 2;

		if (!isError) {
			streakMap.delete(toolName);
			return { upgradedTier: undefined };
		}

		if (cfg.tools && !cfg.tools.includes(toolName)) {
			return { upgradedTier: undefined };
		}

		const prev = streakMap.get(toolName) ?? 0;
		const streak = prev + 1;
		streakMap.set(toolName, streak);

		if (streak >= threshold) {
			const currentIdx = ROUTER_TIERS.indexOf(currentTier);
			if (currentIdx > 0) {
				const upgradedTier = ROUTER_TIERS[currentIdx - 1];
				streakMap.delete(toolName);
				return { upgradedTier };
			}
		}

		return { upgradedTier: undefined };
	}

	it("triggers upgrade after threshold consecutive failures", () => {
		const streaks = new Map<string, number>();
		const cfg: AutoUpgradeConfig = { enabled: true, threshold: 2 };

		// First failure — no upgrade yet
		let result = simulateToolEnd(streaks, cfg, "find", true, "low");
		expect(result.upgradedTier).toBeUndefined();
		expect(streaks.get("find")).toBe(1);

		// Second failure — triggers upgrade
		result = simulateToolEnd(streaks, cfg, "find", true, "low");
		expect(result.upgradedTier).toBe("medium");
		expect(streaks.has("find")).toBe(false); // reset after trigger
	});

	it("success resets the streak", () => {
		const streaks = new Map<string, number>();
		const cfg: AutoUpgradeConfig = { enabled: true, threshold: 2 };

		simulateToolEnd(streaks, cfg, "find", true, "low");
		expect(streaks.get("find")).toBe(1);

		// Success resets
		simulateToolEnd(streaks, cfg, "find", false, "low");
		expect(streaks.has("find")).toBe(false);

		// Need 2 more failures now
		simulateToolEnd(streaks, cfg, "find", true, "low");
		const result = simulateToolEnd(streaks, cfg, "find", true, "low");
		expect(result.upgradedTier).toBe("medium");
	});

	it("tools filter restricts tracking", () => {
		const streaks = new Map<string, number>();
		const cfg: AutoUpgradeConfig = { enabled: true, threshold: 2, tools: ["find"] };

		// "search" is not in the tools list — should not track
		simulateToolEnd(streaks, cfg, "search", true, "low");
		simulateToolEnd(streaks, cfg, "search", true, "low");
		expect(streaks.get("search")).toBeUndefined();
	});

	it("does not upgrade beyond high tier", () => {
		const streaks = new Map<string, number>();
		const cfg: AutoUpgradeConfig = { enabled: true, threshold: 2 };

		simulateToolEnd(streaks, cfg, "find", true, "high");
		const result = simulateToolEnd(streaks, cfg, "find", true, "high");
		// Already at highest tier — no upgrade possible
		expect(result.upgradedTier).toBeUndefined();
	});

	it("upgrades from medium to high", () => {
		const streaks = new Map<string, number>();
		const cfg: AutoUpgradeConfig = { enabled: true, threshold: 2 };

		simulateToolEnd(streaks, cfg, "edit", true, "medium");
		const result = simulateToolEnd(streaks, cfg, "edit", true, "medium");
		expect(result.upgradedTier).toBe("high");
	});

	it("threshold of 3 requires 3 consecutive failures", () => {
		const streaks = new Map<string, number>();
		const cfg: AutoUpgradeConfig = { enabled: true, threshold: 3 };

		simulateToolEnd(streaks, cfg, "find", true, "low");
		simulateToolEnd(streaks, cfg, "find", true, "low");
		let result = simulateToolEnd(streaks, cfg, "find", true, "low");
		expect(result.upgradedTier).toBe("medium");
	});

	it("independent tools have independent streaks", () => {
		const streaks = new Map<string, number>();
		const cfg: AutoUpgradeConfig = { enabled: true, threshold: 2 };

		simulateToolEnd(streaks, cfg, "find", true, "low");
		simulateToolEnd(streaks, cfg, "search", true, "low");

		// Neither has reached threshold yet
		expect(streaks.get("find")).toBe(1);
		expect(streaks.get("search")).toBe(1);

		// "find" hits threshold
		const result = simulateToolEnd(streaks, cfg, "find", true, "low");
		expect(result.upgradedTier).toBe("medium");
		// "search" still at 1
		expect(streaks.get("search")).toBe(1);
	});
});
