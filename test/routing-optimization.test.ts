/**
 * Regression tests for the heuristic cost optimization changes:
 * - Fix A: multiLinePrompt removal
 * - Fix B: Strong/weak keyword split with corroboration gate
 * - Fix C: Word-boundary matching in containsAny
 */

import { describe, it, expect } from "bun:test";
import { decideRouting, containsAny } from "../src/routing";
import type { RouterProfile, RoutingDecision } from "../src/types";

const TEST_PROFILE: RouterProfile = {
	high: { model: "anthropic/claude-sonnet-4-5", thinking: "high" },
	medium: { model: "anthropic/claude-sonnet-4-20250514", thinking: "medium" },
	low: { model: "anthropic/claude-haiku-4-5", thinking: "low" },
};

function createContext(prompt: string, extraMessages: any[] = []) {
	return {
		messages: [
			...extraMessages,
			{ role: "user" as const, content: prompt, timestamp: Date.now() },
		],
	};
}

function route(
	prompt: string,
	opts: {
		previousDecision?: RoutingDecision;
		rules?: any[];
	} = {},
) {
	return decideRouting(
		createContext(prompt),
		"auto",
		TEST_PROFILE,
		opts.previousDecision,
		undefined, // pinnedTier
		undefined, // thinkingOverrides
		0.5, // phaseBias
		opts.rules,
		false, // isBudgetExceeded
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix A: multiLinePrompt removal
// ─────────────────────────────────────────────────────────────────────────────

describe("Fix A: multiLinePrompt no longer triggers high tier", () => {
	it("multi-line code paste routes to medium (not high)", () => {
		const prompt = "fix this:\n  const x = 1;\n  const y = 2;\n  const z = 3;\n  return x + y + z;";
		const decision = route(prompt);
		expect(decision.tier).toBe("medium");
	});

	it("multi-line error log routes to medium", () => {
		const prompt =
			"what's wrong?\nError: ENOENT\n  at Object.open\n  at Module._load\n  at require";
		const decision = route(prompt);
		// Should NOT be high just because of newlines
		expect(decision.tier).not.toBe("high");
	});

	it("multi-line JSON paste routes to medium", () => {
		const prompt = 'update the port:\n{\n  "host": "localhost",\n  "port": 3000,\n  "debug": true\n}';
		const decision = route(prompt);
		expect(decision.tier).toBe("medium");
	});

	it("multi-line prompt with strong planning keyword still routes high", () => {
		const prompt =
			"investigate this:\nline1\nline2\nline3\nline4";
		const decision = route(prompt);
		expect(decision.tier).toBe("high");
		expect(decision.reasoning).toContain("strong planning keyword");
	});

	it("multi-line prompt with 120+ words still routes high via wordCount", () => {
		// Generate a prompt with >120 words on multiple lines
		const words = Array.from({ length: 130 }, (_, i) => `word${i}`);
		const prompt = words.join(" ").replace(/ word50 /g, "\nword50\n").replace(/ word100 /g, "\nword100\n");
		const decision = route(prompt);
		expect(decision.tier).toBe("high");
		expect(decision.reasoning).toContain("high-complexity");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix B: Strong/weak keyword split
// ─────────────────────────────────────────────────────────────────────────────

describe("Fix B: Strong planning keywords route high unconditionally", () => {
	const strongKeywords = [
		"architecture",
		"architect",
		"tradeoff",
		"trade-off",
		"root cause",
		"investigate",
		"migration",
		"analyze",
		"analysis",
	];

	for (const kw of strongKeywords) {
		it(`"${kw}" alone routes to high`, () => {
			const decision = route(`${kw} this`);
			expect(decision.tier).toBe("high");
		});
	}

	it("strong keyword in short prompt still routes high", () => {
		const decision = route("architecture");
		expect(decision.tier).toBe("high");
	});
});

describe("Fix B: Weak keywords WITHOUT corroboration do NOT route high", () => {
	it('"compare these two" (3 words, no corroboration) → not high', () => {
		const decision = route("compare these two");
		expect(decision.tier).not.toBe("high");
	});

	it('"what are my options" (4 words) → not high', () => {
		const decision = route("what are my options");
		expect(decision.tier).not.toBe("high");
	});

	it('"the design looks good" (4 words) → not high', () => {
		const decision = route("the design looks good");
		expect(decision.tier).not.toBe("high");
	});

	it('"plan" (1 word) → not high', () => {
		const decision = route("plan");
		expect(decision.tier).not.toBe("high");
	});

	it('"what approach should I use" (6 words) → not high', () => {
		const decision = route("what approach should I use");
		expect(decision.tier).not.toBe("high");
	});

	it('"compare two strings for equality" (5 words) → not high', () => {
		const decision = route("compare two strings for equality");
		expect(decision.tier).not.toBe("high");
	});

	it('"research" alone (1 word) → not high', () => {
		const decision = route("research");
		expect(decision.tier).not.toBe("high");
	});
});

describe("Fix B: Weak keywords WITH corroboration route high", () => {
	it("weak keyword + wordCount >= 12 → high", () => {
		const decision = route(
			"I need to design the authentication system for our new microservice including rate limiting and token refresh",
		);
		expect(decision.tier).toBe("high");
		expect(decision.reasoning).toContain("corroborated");
	});

	it("weak keyword + 'why ' prefix → high", () => {
		const decision = route("why is this design failing");
		expect(decision.tier).toBe("high");
	});

	it("weak keyword + planning phase bias → high", () => {
		// First get into planning phase
		const planningDecision = route("investigate the root cause of this crash");
		expect(planningDecision.phase).toBe("planning");

		// Now a weak keyword during planning phase should stay high
		const followUp = route("what are the options here", {
			previousDecision: planningDecision,
		});
		expect(followUp.tier).toBe("high");
		expect(followUp.reasoning).toContain("corroborated");
	});

	it("multiple weak keywords with sufficient length → high", () => {
		const decision = route(
			"compare the performance implications of these two caching strategies for our production system",
		);
		expect(decision.tier).toBe("high");
	});

	it("2+ weak keywords in short prompt → high (multi-match corroboration)", () => {
		// "design" + "strategy" = 2 weak keywords, even though only 8 words
		const decision = route("Design a caching strategy for our web app");
		expect(decision.tier).toBe("high");
		expect(decision.reasoning).toContain("corroborated");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Fix C: Word-boundary matching in containsAny
// ─────────────────────────────────────────────────────────────────────────────

describe("Fix C: containsAny uses word-boundary matching", () => {
	it("matches exact word 'deploy'", () => {
		expect(containsAny("deploy the service", ["deploy"])).toBe(true);
	});

	it("does NOT match 'deploy' as substring of 'undeployed'", () => {
		expect(containsAny("undeployed resources", ["deploy"])).toBe(false);
	});

	it("does NOT match 'deploy' as substring of 'redeployment'", () => {
		expect(containsAny("redeployment plan", ["deploy"])).toBe(false);
	});

	it("matches exact word at start of string", () => {
		expect(containsAny("deploy now", ["deploy"])).toBe(true);
	});

	it("matches exact word at end of string", () => {
		expect(containsAny("ready to deploy", ["deploy"])).toBe(true);
	});

	it("multi-word phrases still use substring matching", () => {
		expect(
			containsAny("we need to deploy to production", ["deploy to production"]),
		).toBe(true);
	});

	it("multi-word phrase does NOT require word boundaries", () => {
		expect(
			containsAny("deploy to production-staging", ["deploy to production"]),
		).toBe(true);
	});

	it("does NOT match 'release' in 'prereleased'", () => {
		expect(containsAny("prereleased version", ["release"])).toBe(false);
	});

	it("matches 'release' as standalone word", () => {
		expect(containsAny("release the build", ["release"])).toBe(true);
	});

	it("case insensitive matching for single words", () => {
		expect(containsAny("Deploy the app", ["deploy"])).toBe(true);
		expect(containsAny("DEPLOY NOW", ["deploy"])).toBe(true);
	});
});

describe("Fix C: Custom rules with word-boundary matching via decideRouting", () => {
	const rules = [
		{ matches: ["deploy", "production"], tier: "high" as const, reason: "Safety check" },
		{ matches: ["changelog"], tier: "low" as const },
	];

	it("rule matches exact word 'deploy'", () => {
		const decision = route("deploy the fix", { rules });
		expect(decision.tier).toBe("high");
		expect(decision.isRuleMatched).toBe(true);
	});

	it("rule does NOT match 'undeployed'", () => {
		const decision = route("the undeployed changes need review", { rules });
		expect(decision.isRuleMatched).not.toBe(true);
	});

	it("rule matches 'production' but not 'reproductional'", () => {
		const decision = route("push to production", { rules });
		expect(decision.tier).toBe("high");
		expect(decision.isRuleMatched).toBe(true);

		const decision2 = route("reproductional issues in the test", { rules });
		expect(decision2.isRuleMatched).not.toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined: Ensure no regressions on genuine planning prompts
// ─────────────────────────────────────────────────────────────────────────────

describe("No regressions on genuine high-tier prompts", () => {
	it("'Design a microservice architecture for our payment system' → high", () => {
		const decision = route(
			"Design a microservice architecture for our payment system that handles 10k TPS with 99.99% uptime",
		);
		expect(decision.tier).toBe("high");
	});

	it("'Analyze the tradeoffs between Redis vs PostgreSQL' → high", () => {
		const decision = route(
			"Analyze the tradeoffs between using Redis vs PostgreSQL for our session cache",
		);
		expect(decision.tier).toBe("high");
	});

	it("long complex prompt without keywords still routes high via wordCount", () => {
		const longPrompt = "I need you to carefully evaluate the performance characteristics of our current database setup considering the read-write ratio is about 95:5 and we are seeing p99 latencies above 200ms during peak hours which started after the last deployment when we added the new indexing strategy that was supposed to improve things but clearly made them worse in some edge cases that we need to understand before we can fix it properly without causing more regressions";
		const decision = route(longPrompt);
		expect(decision.tier).toBe("high");
	});

	it("'why' prefix still routes high", () => {
		const decision = route("why is this happening in our auth flow");
		expect(decision.tier).toBe("high");
	});

	it("explicit high hints still work", () => {
		const decision = route("carefully review this code");
		expect(decision.tier).toBe("high");
	});
});

describe("No regressions on medium/low tier prompts", () => {
	it("implementation keywords route medium", () => {
		const decision = route("implement the JWT validation middleware");
		expect(decision.tier).toBe("medium");
	});

	it("summary keywords route low", () => {
		const decision = route("summarize the changes in this PR");
		expect(decision.tier).toBe("low");
	});

	it("explicit low hints route low", () => {
		const decision = route("quick summary please");
		expect(decision.tier).toBe("low");
	});

	it("lookup keywords route low", () => {
		const decision = route("where is the auth module");
		expect(decision.tier).toBe("low");
	});
});
// ─────────────────────────────────────────────────────────────────────────────
// Git operations: must route low or medium, never high
// ─────────────────────────────────────────────────────────────────────────────

describe("Git operations route low tier", () => {
	const gitPrompts = [
		"do a commit",
		"commit the changes",
		"commit",
		"push to origin",
		"push",
		"pull the latest",
		"git pull",
		"git push",
		"git status",
		"git log",
		"git diff",
		"git add .",
		"stash my changes",
		"checkout main",
		"create a new branch",
		"merge the PR branch",
		"rebase onto main",
		"cherry-pick that commit",
		"amend the last commit",
		"revert the last commit",
		"tag this release",
		"fetch origin",
		"reset to HEAD",
	];

	for (const prompt of gitPrompts) {
		it(`"${prompt}" routes low`, () => {
			const decision = route(prompt);
			expect(decision.tier).toBe("low");
			expect(decision.phase).toBe("lightweight");
		});
	}

	it("git commit does not route high even after a planning phase", () => {
		const planningDecision = route("analyze the architecture of this codebase");
		expect(planningDecision.tier).toBe("high");
		const decision = route("commit the changes", {
			previousDecision: planningDecision,
		});
		expect(decision.tier).toBe("low");
	});

	it("git push does not route medium via implementation fallback", () => {
		const decision = route("push the changes to origin");
		expect(decision.tier).toBe("low");
	});
});
