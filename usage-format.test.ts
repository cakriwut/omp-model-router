/**
 * Unit test for /router usage output format.
 * Verifies the stacked bar, colors, and layout.
 */

import { describe, it, expect } from "bun:test";
import type { RoutingDecision, RouterTier } from "./types";

// Simulate theme.fg — wraps text in identifiable ANSI markers
function createMockTheme() {
	// Use real ANSI codes so the test output is visually verifiable
	const ANSI = {
		success: "\x1b[32m", // green
		warning: "\x1b[33m", // yellow
		dim: "\x1b[2m", // dim
		reset: "\x1b[39m",
	};
	return {
		fg(color: string, text: string): string {
			const code = ANSI[color as keyof typeof ANSI] ?? "";
			return `${code}${text}${ANSI.reset}`;
		},
	};
}

// Reproduce the handleUsage logic in isolation for testability
function renderUsageReport(opts: {
	selectedProfile: string;
	accumulatedCost: number;
	maxSessionBudget?: number;
	debugHistory: RoutingDecision[];
	profileConfig: {
		high: { model: string; fallbacks?: string[] };
		medium: { model: string; fallbacks?: string[] };
		low: { model: string; fallbacks?: string[] };
	};
	models: Record<
		string,
		{ contextWindow: number; maxTokens: number; reasoning: boolean; cost?: { input: number; output: number } }
	>;
}): string {
	const theme = createMockTheme();
	const BAR_WIDTH = 48;

	const tierColor = (tier: string, text: string) => {
		switch (tier) {
			case "high":
				return theme.fg("success", text);
			case "medium":
				return theme.fg("warning", text);
			default:
				return theme.fg("dim", text);
		}
	};

	// Gather per-model usage
	const modelUsage: Record<string, { count: number; tier: string }> = {};
	for (const decision of opts.debugHistory) {
		if (decision.profile !== opts.selectedProfile) continue;
		const key = decision.targetLabel;
		if (!modelUsage[key]) {
			modelUsage[key] = { count: 0, tier: decision.tier };
		}
		modelUsage[key].count++;
	}

	// Tier distribution
	const tierCounts = { high: 0, medium: 0, low: 0 };
	for (const decision of opts.debugHistory) {
		if (decision.profile !== opts.selectedProfile) continue;
		if (decision.tier in tierCounts) {
			tierCounts[decision.tier as keyof typeof tierCounts]++;
		}
	}
	const totalDecisions = tierCounts.high + tierCounts.medium + tierCounts.low;

	// Header line
	const budget = opts.maxSessionBudget;
	const costStr = budget
		? `$${opts.accumulatedCost.toFixed(4)} / $${budget.toFixed(2)}`
		: `$${opts.accumulatedCost.toFixed(4)}`;
	const headerLeft = `Router: ${opts.selectedProfile}`;
	const headerPad = Math.max(1, BAR_WIDTH + 2 - headerLeft.length - costStr.length);
	const headerLine = `${headerLeft}${" ".repeat(headerPad)}${costStr}`;

	// Stacked bar
	let barLine: string;
	let labelLine: string;
	if (totalDecisions > 0) {
		const highWidth = Math.round((tierCounts.high / totalDecisions) * BAR_WIDTH);
		const mediumWidth = Math.round((tierCounts.medium / totalDecisions) * BAR_WIDTH);
		const lowWidth = Math.max(0, BAR_WIDTH - highWidth - mediumWidth);

		const highSeg = tierColor("high", "█".repeat(highWidth));
		const medSeg = tierColor("medium", "█".repeat(mediumWidth));
		const lowSeg = tierColor("low", "█".repeat(lowWidth));
		barLine = `${highSeg}${medSeg}${lowSeg} ${totalDecisions} decisions`;

		const highPct = Math.round((tierCounts.high / totalDecisions) * 100);
		const medPct = Math.round((tierCounts.medium / totalDecisions) * 100);
		const lowPct = Math.round((tierCounts.low / totalDecisions) * 100);

		const highLabel = `high ${highPct}%`;
		const medLabel = `medium ${medPct}%`;
		const lowLabel = `low ${lowPct}%`;

		const highLabelPad = Math.max(0, Math.floor((highWidth - highLabel.length) / 2));
		const highLabelEnd = Math.max(0, highWidth - highLabelPad - highLabel.length);
		const medLabelPad = Math.max(0, Math.floor((mediumWidth - medLabel.length) / 2));
		const medLabelEnd = Math.max(0, mediumWidth - medLabelPad - medLabel.length);
		const lowLabelPad = Math.max(0, Math.floor((lowWidth - lowLabel.length) / 2));

		labelLine = [
			" ".repeat(highLabelPad),
			tierColor("high", highLabel),
			" ".repeat(highLabelEnd),
			" ".repeat(medLabelPad),
			tierColor("medium", medLabel),
			" ".repeat(medLabelEnd),
			" ".repeat(lowLabelPad),
			tierColor("low", lowLabel),
		].join("");
	} else {
		barLine = theme.fg("dim", "░".repeat(BAR_WIDTH)) + " 0 decisions";
		labelLine = theme.fg("dim", "no routing history");
	}

	// Model lines
	const TIERS: RouterTier[] = ["high", "medium", "low"];
	const modelLines: string[] = [];
	for (const tier of TIERS) {
		const tierConfig = opts.profileConfig[tier];
		const modelRef = tierConfig.model;
		const parts = modelRef.split("/");
		const modelId = parts.length > 1 ? parts.slice(1).join("/") : parts[0];
		const usageCount = modelUsage[modelRef]?.count ?? 0;

		const modelMeta = opts.models[modelRef];
		const tierCost = modelMeta?.cost
			? usageCount > 0
				? `$${(usageCount * ((modelMeta.cost.input + modelMeta.cost.output) / 2)).toFixed(4)}`
				: "$0"
			: "";

		const tierLabel = tierColor(tier, tier.toUpperCase().padEnd(8));
		const modelName = modelId.padEnd(38);
		const countStr = `${usageCount}x`.padStart(4);

		modelLines.push(`  ${tierLabel}${modelName}${countStr}   ${tierCost}`);

		if (tierConfig.fallbacks?.length) {
			for (const fb of tierConfig.fallbacks) {
				const fbParts = fb.split("/");
				const fbId = fbParts.length > 1 ? fbParts.slice(1).join("/") : fbParts[0];
				const fbUsage = modelUsage[fb]?.count ?? 0;
				modelLines.push(`  ${" ".repeat(8)}└ ${fbId.padEnd(36)}${`${fbUsage}x`.padStart(4)}`);
			}
		}
	}

	// Assemble
	const lines = [headerLine, barLine, labelLine, "", ...modelLines];

	const lastDecision = opts.debugHistory.filter((d) => d.profile === opts.selectedProfile).at(-1);
	if (lastDecision) {
		const ld = lastDecision;
		lines.push("", `Last: ${tierColor(ld.tier, ld.tier)} → ${ld.targetProvider}/${ld.targetModelId} (${ld.thinking})`);
	}

	return lines.join("\n");
}

// Helper to create a decision
function makeDecision(overrides: Partial<RoutingDecision> & { tier: RouterTier }): RoutingDecision {
	return {
		profile: "default",
		tier: overrides.tier,
		phase: "implementation",
		targetProvider: "anthropic",
		targetModelId: "claude-sonnet-4-20250514",
		targetLabel: "anthropic/claude-sonnet-4-20250514",
		reasoning: "test",
		thinking: "medium",
		timestamp: Date.now(),
		...overrides,
	};
}

// Strip ANSI for structural assertions
function stripAnsi(str: string): string {
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("/router usage format", () => {
	const baseOpts = {
		selectedProfile: "default",
		accumulatedCost: 0.1234,
		maxSessionBudget: 5.0,
		profileConfig: {
			high: { model: "anthropic/claude-sonnet-4-20250514" },
			medium: { model: "anthropic/claude-3-5-haiku-20241022" },
			low: { model: "anthropic/claude-3-haiku-20240307", fallbacks: ["openai/gpt-4o-mini"] },
		},
		models: {
			"anthropic/claude-sonnet-4-20250514": {
				contextWindow: 200_000,
				maxTokens: 8192,
				reasoning: true,
				cost: { input: 3, output: 15 },
			},
			"anthropic/claude-3-5-haiku-20241022": {
				contextWindow: 200_000,
				maxTokens: 8192,
				reasoning: false,
				cost: { input: 1, output: 5 },
			},
			"anthropic/claude-3-haiku-20240307": {
				contextWindow: 200_000,
				maxTokens: 4096,
				reasoning: false,
				cost: { input: 0.25, output: 1.25 },
			},
		},
		debugHistory: [
			// 5 high, 12 medium, 3 low = 20 total
			...Array.from({ length: 5 }, () =>
				makeDecision({
					tier: "high",
					targetProvider: "anthropic",
					targetModelId: "claude-sonnet-4-20250514",
					targetLabel: "anthropic/claude-sonnet-4-20250514",
				}),
			),
			...Array.from({ length: 12 }, () =>
				makeDecision({
					tier: "medium",
					targetProvider: "anthropic",
					targetModelId: "claude-3-5-haiku-20241022",
					targetLabel: "anthropic/claude-3-5-haiku-20241022",
				}),
			),
			...Array.from({ length: 3 }, () =>
				makeDecision({
					tier: "low",
					targetProvider: "anthropic",
					targetModelId: "claude-3-haiku-20240307",
					targetLabel: "anthropic/claude-3-haiku-20240307",
				}),
			),
		],
	};

	it("renders the full output with ANSI colors", () => {
		const output = renderUsageReport(baseOpts);
		// Print it so the test runner shows the colored output
		console.log("\n--- /router usage output (with ANSI colors) ---");
		console.log(output);
		console.log("--- end ---\n");

		// Structural assertions on stripped version
		const plain = stripAnsi(output);
		expect(plain).toContain("Router: default");
		expect(plain).toContain("$0.1234 / $5.00");
		expect(plain).toContain("20 decisions");
		expect(plain).toContain("high 25%");
		expect(plain).toContain("medium 60%");
		expect(plain).toContain("low 15%");
		expect(plain).toContain("HIGH");
		expect(plain).toContain("MEDIUM");
		expect(plain).toContain("LOW");
		expect(plain).toContain("claude-sonnet-4-20250514");
		expect(plain).toContain("5x");
		expect(plain).toContain("12x");
		expect(plain).toContain("3x");
	});

	it("uses green ANSI for HIGH tier", () => {
		const output = renderUsageReport(baseOpts);
		// \x1b[32m = green (success)
		expect(output).toContain("\x1b[32mHIGH");
		expect(output).toContain("\x1b[32m" + "█".repeat(12)); // 25% of 48 = 12
	});

	it("uses yellow ANSI for MEDIUM tier", () => {
		const output = renderUsageReport(baseOpts);
		// \x1b[33m = yellow (warning)
		expect(output).toContain("\x1b[33mMEDIUM");
		expect(output).toContain("\x1b[33m" + "█".repeat(29)); // 60% of 48 = 29
	});

	it("uses dim ANSI for LOW tier", () => {
		const output = renderUsageReport(baseOpts);
		// \x1b[2m = dim
		expect(output).toContain("\x1b[2mLOW");
	});

	it("stacked bar segments sum to BAR_WIDTH", () => {
		const output = renderUsageReport(baseOpts);
		const plain = stripAnsi(output);
		const lines = plain.split("\n");
		// Bar line is line index 1
		const barLine = lines[1];
		const blocks = (barLine.match(/█/g) || []).length;
		expect(blocks).toBe(48);
	});

	it("shows fallback models indented", () => {
		const output = renderUsageReport(baseOpts);
		const plain = stripAnsi(output);
		expect(plain).toContain("└ gpt-4o-mini");
	});

	it("renders empty state gracefully", () => {
		const output = renderUsageReport({
			...baseOpts,
			debugHistory: [],
		});
		console.log("\n--- /router usage output (empty state) ---");
		console.log(output);
		console.log("--- end ---\n");

		const plain = stripAnsi(output);
		expect(plain).toContain("0 decisions");
		expect(plain).toContain("no routing history");
		expect(plain).toContain("0x");
	});

	it("shows last decision with colored tier", () => {
		const output = renderUsageReport(baseOpts);
		// Last decision is "low" tier (last in the array)
		expect(output).toContain("\x1b[2mlow\x1b[39m →");
		const plain = stripAnsi(output);
		expect(plain).toContain("Last: low → anthropic/claude-3-haiku-20240307 (medium)");
	});

	it("header right-aligns cost with budget", () => {
		const plain = stripAnsi(renderUsageReport(baseOpts));
		const headerLine = plain.split("\n")[0];
		expect(headerLine.startsWith("Router: default")).toBe(true);
		expect(headerLine.endsWith("$0.1234 / $5.00")).toBe(true);
	});

	it("shows cost without budget when maxSessionBudget is not set", () => {
		const output = renderUsageReport({
			...baseOpts,
			maxSessionBudget: undefined,
		});
		const plain = stripAnsi(output);
		const headerLine = plain.split("\n")[0];
		expect(headerLine).toContain("$0.1234");
		expect(headerLine).not.toContain("/");
	});
});
