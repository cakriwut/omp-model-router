/**
 * Cross-tier fallback: when all models in the primary chain fail with retryable
 * errors (e.g. account-level 429), the router should try models from other tiers.
 */
import { describe, test, expect } from "bun:test";
import { isRetryableStatus } from "../src/embargo";

describe("Cross-tier fallback", () => {
	describe("error detection for rate limit messages", () => {
		test("detects 429 status directly", () => {
			expect(isRetryableStatus(429, "Rate limited")).toBe(true);
		});

		test("detects rate_limit_error in JSON body without status", () => {
			const msg = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit"}}';
			expect(isRetryableStatus(undefined, msg)).toBe(true);
		});

		test("detects 'rate limit' text pattern without status code", () => {
			const msg = "This request would exceed your account's rate limit";
			expect(isRetryableStatus(undefined, msg)).toBe(true);
		});

		test("does not false-positive on non-retryable errors", () => {
			expect(isRetryableStatus(401, "Unauthorized")).toBe(false);
			expect(isRetryableStatus(403, "Forbidden")).toBe(false);
			expect(isRetryableStatus(400, "Bad request")).toBe(false);
		});

		test("detects overloaded pattern", () => {
			expect(isRetryableStatus(undefined, "The server is overloaded")).toBe(true);
		});

		test("detects 503 status", () => {
			expect(isRetryableStatus(503, "Service unavailable")).toBe(true);
		});

		test("detects 529 status (Anthropic overloaded)", () => {
			expect(isRetryableStatus(529, "Overloaded")).toBe(true);
		});
	});

	describe("cross-tier model collection logic", () => {
		const ROUTER_TIERS = ["high", "medium", "low"] as const;

		function collectCrossTierModels(
			currentTier: "high" | "medium" | "low",
			profile: Record<string, { model: string; fallbacks?: string[] }>,
			alreadyTried: string[],
		): string[] {
			const triedModels = new Set(alreadyTried);
			const tierOrder: Array<"high" | "medium" | "low"> = [];
			const currentTierIdx = ROUTER_TIERS.indexOf(currentTier);

			// Lower tiers first (cheaper)
			for (let t = currentTierIdx + 1; t < ROUTER_TIERS.length; t++) {
				tierOrder.push(ROUTER_TIERS[t]);
			}
			// Then higher tiers
			for (let t = currentTierIdx - 1; t >= 0; t--) {
				tierOrder.push(ROUTER_TIERS[t]);
			}

			const crossTierModels: string[] = [];
			for (const tier of tierOrder) {
				const tierConfig = profile[tier];
				if (tierConfig.model && !triedModels.has(tierConfig.model)) {
					crossTierModels.push(tierConfig.model);
					triedModels.add(tierConfig.model);
				}
				for (const fb of tierConfig.fallbacks ?? []) {
					if (!triedModels.has(fb)) {
						crossTierModels.push(fb);
						triedModels.add(fb);
					}
				}
			}
			return crossTierModels;
		}

		test("collects models from lower tiers first when high fails", () => {
			const profile = {
				high: { model: "anthropic/opus", fallbacks: ["anthropic/sonnet"] },
				medium: { model: "anthropic/sonnet", fallbacks: ["openai/gpt-4"] },
				low: { model: "openai/gpt-4-mini", fallbacks: ["google/flash"] },
			};

			const result = collectCrossTierModels(
				"high",
				profile,
				["anthropic/opus", "anthropic/sonnet"], // already tried
			);

			// anthropic/sonnet is already tried (in both high fallbacks and medium primary)
			// Should get: openai/gpt-4 (medium fallback), openai/gpt-4-mini (low primary), google/flash (low fallback)
			expect(result).toEqual(["openai/gpt-4", "openai/gpt-4-mini", "google/flash"]);
		});

		test("collects models from both directions when medium fails", () => {
			const profile = {
				high: { model: "anthropic/opus", fallbacks: [] },
				medium: { model: "anthropic/sonnet", fallbacks: [] },
				low: { model: "openai/gpt-4-mini", fallbacks: ["google/flash"] },
			};

			const result = collectCrossTierModels(
				"medium",
				profile,
				["anthropic/sonnet"], // already tried
			);

			// Lower first (low), then higher (high)
			expect(result).toEqual(["openai/gpt-4-mini", "google/flash", "anthropic/opus"]);
		});

		test("deduplicates models that appear in multiple tiers", () => {
			const profile = {
				high: { model: "anthropic/opus", fallbacks: ["shared/model-a"] },
				medium: { model: "shared/model-a", fallbacks: [] },
				low: { model: "shared/model-a", fallbacks: ["openai/mini"] },
			};

			const result = collectCrossTierModels(
				"high",
				profile,
				["anthropic/opus", "shared/model-a"], // already tried
			);

			// shared/model-a already tried; only openai/mini is new
			expect(result).toEqual(["openai/mini"]);
		});

		test("returns empty when all models were already tried", () => {
			const profile = {
				high: { model: "anthropic/opus", fallbacks: [] },
				medium: { model: "anthropic/sonnet", fallbacks: [] },
				low: { model: "anthropic/haiku", fallbacks: [] },
			};

			const result = collectCrossTierModels(
				"high",
				profile,
				["anthropic/opus", "anthropic/sonnet", "anthropic/haiku"],
			);

			expect(result).toEqual([]);
		});

		test("handles profile with cross-provider fallbacks", () => {
			const profile = {
				high: { model: "anthropic/opus", fallbacks: ["anthropic/sonnet"] },
				medium: { model: "anthropic/sonnet", fallbacks: ["amazon-bedrock/nova-pro"] },
				low: { model: "google/flash", fallbacks: ["amazon-bedrock/nova-micro"] },
			};

			const result = collectCrossTierModels(
				"high",
				profile,
				["anthropic/opus", "anthropic/sonnet"], // account-level 429 hit both
			);

			// Gets cross-provider models from other tiers
			expect(result).toEqual(["amazon-bedrock/nova-pro", "google/flash", "amazon-bedrock/nova-micro"]);
		});
	});
});
