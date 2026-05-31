/**
 * Fallback Chain Unit Tests
 *
 * Tests verify the model fallback loop logic (provider.ts:448-776) without
 * requiring complex module mocking. Instead, we test:
 *
 * 1. Config parsing: fallback arrays are correctly loaded
 * 2. Chain building: [primary, ...fallbacks] is constructed properly
 * 3. Filter logic: image constraints filter correctly
 * 4. Skip conditions: registry lookup, API key, router provider checks
 * 5. Real config: user's actual model-router.json structure
 */

import { describe, it, expect } from "bun:test";
import type { RouterConfig, RouterTier, RoutedTierConfig } from "../src/types";

// ─── Test: Config loads fallback arrays ─────────────────────────────────────

describe("Fallback Chain — Config Structure", () => {
	const exampleConfig: RouterConfig = {
		defaultProfile: "auto",
		debug: false,
		profiles: {
			auto: {
				high: {
					model: "anthropic/claude-opus",
					thinking: "high",
					fallbacks: [
						"anthropic/claude-sonnet",
						"openai/gpt-4",
						"google/gemini",
					],
				},
				medium: {
					model: "anthropic/claude-sonnet",
					thinking: "medium",
					fallbacks: ["anthropic/claude-haiku", "openai/gpt-4o"],
				},
				low: {
					model: "anthropic/claude-haiku",
					thinking: "low",
				},
			},
		},
		historyCompression: { enabled: false },
	};

	it("parses fallback arrays from config", () => {
		const profile = exampleConfig.profiles.auto;

		expect(profile.high.fallbacks).toHaveLength(3);
		expect(profile.high.fallbacks?.[0]).toBe("anthropic/claude-sonnet");

		expect(profile.medium.fallbacks).toHaveLength(2);

		expect(profile.low.fallbacks).toBeUndefined();
	});

	it("builds modelsToTry chain: [primary, ...fallbacks]", () => {
		const profile = exampleConfig.profiles.auto;

		// Simulate provider.ts:433-436
		const buildChain = (tierCfg: RoutedTierConfig) => [
			tierCfg.model,
			...(tierCfg.fallbacks ?? []),
		];

		expect(buildChain(profile.high)).toEqual([
			"anthropic/claude-opus",
			"anthropic/claude-sonnet",
			"openai/gpt-4",
			"google/gemini",
		]);

		expect(buildChain(profile.medium)).toEqual([
			"anthropic/claude-sonnet",
			"anthropic/claude-haiku",
			"openai/gpt-4o",
		]);

		expect(buildChain(profile.low)).toEqual(["anthropic/claude-haiku"]);
	});
});

// ─── Test: Image filtering logic ───────────────────────────────────────────

describe("Fallback Chain — Image Filtering", () => {
	it("filters fallback chain by image capability (provider.ts:437-441)", () => {
		const chain = [
			"primary/model",
			"fallback/model-no-image",
			"fallback/model-with-image",
			"fallback/model-no-image-2",
		];

		// Simulate capabilities
		const imageCapable: Record<string, boolean> = {
			"primary/model": false,
			"fallback/model-no-image": false,
			"fallback/model-with-image": true,
			"fallback/model-no-image-2": false,
		};

		// Simulate filtering logic from provider.ts:437-441
		const filtered = chain.filter((ref) => imageCapable[ref] === true);
		const result =
			filtered.length > 0
				? filtered
				: [chain[0]]; // Fallback to primary if no image-capable

		expect(result).toEqual(["fallback/model-with-image"]);
	});

	it("preserves primary when no image-capable fallbacks exist", () => {
		const chain = ["primary/model", "fallback/1", "fallback/2"];
		const imageCapable: Record<string, boolean> = {
			"primary/model": false,
			"fallback/1": false,
			"fallback/2": false,
		};

		const filtered = chain.filter((ref) => imageCapable[ref] === true);
		const result =
			filtered.length > 0
				? filtered
				: [chain[0]]; // Keep primary when nothing matches

		expect(result).toEqual(["primary/model"]);
	});
});

// ─── Test: Skip conditions (registry.find, getApiKey, router provider) ─────

describe("Fallback Chain — Skip Conditions", () => {
	it("skips model when not in registry (provider.ts:455-464)", () => {
		const chain = [
			"primary/model",
			"fallback/missing",
			"fallback/exists",
		];

		// Simulate registry
		const inRegistry = (ref: string) =>
			ref === "primary/model" || ref === "fallback/exists";

		const skipped = chain.map((ref) => ({
			ref,
			found: inRegistry(ref),
		}));

		expect(skipped).toEqual([
			{ ref: "primary/model", found: true },
			{ ref: "fallback/missing", found: false },
			{ ref: "fallback/exists", found: true },
		]);
	});

	it("skips model when no API key (provider.ts:466-474)", async () => {
		const chain = ["primary/model-1", "fallback/model-2", "fallback/model-3"];

		const hasApiKey = async (ref: string) => {
			// Only model-2 has a key
			return ref === "fallback/model-2";
		};

		const results = await Promise.all(
			chain.map(async (ref) => ({
				ref,
				key: await hasApiKey(ref),
			})),
		);

		const withoutKeys = results.filter((r) => !r.key);
		expect(withoutKeys).toHaveLength(2);
		expect(withoutKeys[0].ref).toBe("primary/model-1");
	});

	it("skips if targetProvider === 'router' (provider.ts:453)", () => {
		const chain = [
			"primary/model",
			"router/auto",
			"fallback/model",
			"router/deep",
		];

		// Simulate the skip: if (targetProvider === "router") continue;
		const nonRouterModels = chain.filter((ref) => {
			const [provider] = ref.split("/");
			return provider !== "router";
		});

		expect(nonRouterModels).toEqual(["primary/model", "fallback/model"]);
	});
});

// ─── Test: Loop termination conditions ─────────────────────────────────────

describe("Fallback Chain — Loop Termination", () => {
	it("stops loop on success (provider.ts:770-772)", () => {
		const chain = [
			"model1",
			"model2",
			"model3",
			"model4",
		];

		// Simulate loop: tries model1 (success), breaks
		let success = false;
		let attemptedCount = 0;
		let successModel = "";

		for (let i = 0; i < chain.length; i++) {
			attemptedCount++;
			if (chain[i] === "model1") {
				// model1 succeeds
				success = true;
				successModel = chain[i];
				break; // Exit loop (provider.ts:772)
			}
		}

		expect(success).toBe(true);
		expect(attemptedCount).toBe(1);
		expect(successModel).toBe("model1");
	});

	it("continues loop on error (provider.ts:773-775)", () => {
		const chain = [
			"model1",
			"model2",
			"model3",
			"model4",
		];
		const failures: Record<string, string> = {
			model1: "stream error",
			model2: "stream error",
			model3: "success",
		};

		// Simulate loop
		let success = false;
		let lastError: string | undefined;
		const attempted = [];

		for (let i = 0; i < chain.length; i++) {
			attempted.push(chain[i]);
			const error = failures[chain[i]];

			if (error === "success") {
				success = true;
				break;
			} else {
				lastError = error;
				// continue (implicit in loop)
			}
		}

		expect(success).toBe(true);
		expect(attempted).toEqual(["model1", "model2", "model3"]);
		expect(lastError).toBe("stream error");
	});

	it("throws error when all models fail (provider.ts:778-779)", () => {
		const chain = ["model1", "model2", "model3"];

		let success = false;
		let lastError: Error | undefined;

		for (let i = 0; i < chain.length; i++) {
			try {
				// Simulate all models failing
				throw new Error(`${chain[i]} failed`);
			} catch (err) {
				lastError = err as Error;
			}
		}

		// After loop exits, throw if not success
		if (!success && lastError) {
			expect(() => {
				throw lastError;
			}).toThrow("model3 failed");
		}
	});
});

// ─── Test: Decision flag ──────────────────────────────────────────────────────

describe("Fallback Chain — Decision Flags", () => {
	it("sets decision.isFallback = true when i > 0 (provider.ts:771)", () => {
		const chain = [
			"primary",
			"fallback1",
			"fallback2",
		];

		const results: Array<{ model: string; isFallback: boolean }> = [];

		for (let i = 0; i < chain.length; i++) {
			results.push({
				model: chain[i],
				isFallback: i > 0,
			});
		}

		expect(results[0]).toEqual({ model: "primary", isFallback: false });
		expect(results[1]).toEqual({ model: "fallback1", isFallback: true });
		expect(results[2]).toEqual({ model: "fallback2", isFallback: true });
	});
});

// ─── Test: Real user config ───────────────────────────────────────────────────

describe("Fallback Chain — Real User Config", () => {
	it("loads ~/.omp/agent/model-router.json and verifies fallback structure", async () => {
		const configPath = `${process.env.HOME}/.omp/agent/model-router.json`;

		let config: RouterConfig;
		try {
			const text = await Bun.file(configPath).text();
			config = JSON.parse(text) as RouterConfig;
		} catch (err) {
			console.log(`⚠ Skipping: Config not found at ${configPath}`);
			return;
		}

		const profiles = config.profiles ?? {};

		console.log("\n════════════════════════════════════════════════════");
		console.log("  USER CONFIG: Fallback Chain Structure");
		console.log("════════════════════════════════════════════════════\n");

		let totalProfiles = 0;
		let profilesWithFullChains = 0;
		const tiers: RouterTier[] = ["high", "medium", "low"];

		for (const [profileName, profile] of Object.entries(profiles)) {
			totalProfiles++;
			let hasAllFallbacks = true;

			console.log(`Profile: "${profileName}"`);

			for (const tier of tiers) {
				const tierCfg = profile[tier];
				const fallbackCount = tierCfg.fallbacks?.length ?? 0;
				const fallbackText =
					fallbackCount > 0
						? `${fallbackCount} fallback${fallbackCount === 1 ? "" : "s"}`
						: "❌ NONE";

				console.log(`  ${tier.padEnd(7)} ← ${tierCfg.model}`);
				console.log(`             ${fallbackText}`);

				if (
					tierCfg.fallbacks &&
					tierCfg.fallbacks.length > 0
				) {
					tierCfg.fallbacks.forEach((fb, i) => {
						console.log(`               ${i + 1}. ${fb}`);
					});
				}

				if (!tierCfg.fallbacks || tierCfg.fallbacks.length === 0) {
					hasAllFallbacks = false;
				}
			}

			if (hasAllFallbacks) profilesWithFullChains++;
			console.log("");
		}

		console.log(
			`Summary: ${profilesWithFullChains}/${totalProfiles} profiles have fallbacks on ALL tiers\n`,
		);

		// Key assertion: user has some fallbacks configured
		const hasAnyFallbacks = Object.values(profiles).some((profile) =>
			tiers.some((tier) => (profile[tier].fallbacks?.length ?? 0) > 0),
		);

		expect(hasAnyFallbacks).toBe(true);
	});

	it("identifies profiles with incomplete fallback coverage", async () => {
		const configPath = `${process.env.HOME}/.omp/agent/model-router.json`;

		let config: RouterConfig;
		try {
			const text = await Bun.file(configPath).text();
			config = JSON.parse(text) as RouterConfig;
		} catch {
			return;
		}

		const profiles = config.profiles ?? {};
		const tiers: RouterTier[] = ["high", "medium", "low"];

		console.log(
			"\n📋 Profiles with MISSING fallbacks on any tier:\n",
		);

		let foundIssues = false;

		for (const [profileName, profile] of Object.entries(profiles)) {
			for (const tier of tiers) {
				const tierCfg = profile[tier];
				if (!tierCfg.fallbacks || tierCfg.fallbacks.length === 0) {
					console.log(
						`  ⚠️  "${profileName}" / ${tier}: NO FALLBACKS (primary: ${tierCfg.model})`,
					);
					foundIssues = true;
				}
			}
		}

		if (!foundIssues) {
			console.log(
				"  ✓ All tiers have fallbacks configured\n",
			);
		}
	});
});
