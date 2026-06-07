import { describe, it, expect } from "bun:test";
import { detectTaskType } from "../src/routing/heuristic";
import { resolveProfileForTaskType, normalizeConfig } from "../src/config";
import type { RouterConfig, RouterProfile, TaskType } from "../src/types";

// ─── detectTaskType ──────────────────────────────────────────────────────────

describe("detectTaskType", () => {
	it("detects coding tasks", () => {
		expect(detectTaskType("create a calculator in python")).toBe("coding");
		expect(detectTaskType("implement a REST API endpoint")).toBe("coding");
		expect(detectTaskType("fix the bug in the login function")).toBe("coding");
		expect(detectTaskType("refactor the database module")).toBe("coding");
		expect(detectTaskType("debug this exception")).toBe("coding");
	});

	it("detects research tasks", () => {
		expect(detectTaskType("explain how transformers work")).toBe("research");
		expect(detectTaskType("what is the difference between TCP and UDP")).toBe("research");
		expect(detectTaskType("compare React and Vue pros and cons")).toBe("research");
		expect(detectTaskType("investigate the performance issue")).toBe("research");
	});

	it("detects math tasks", () => {
		expect(detectTaskType("calculate the integral of x^2")).toBe("math");
		expect(detectTaskType("solve this equation for x")).toBe("math");
		expect(detectTaskType("compute the probability of rolling a 6")).toBe("math");
		expect(detectTaskType("prove this theorem using induction")).toBe("math");
	});

	it("detects writing tasks", () => {
		expect(detectTaskType("draft a blog post about AI")).toBe("writing");
		expect(detectTaskType("write an email to the team")).toBe("writing");
		expect(detectTaskType("write a story about a cat")).toBe("writing");
	});

	it("detects summarization tasks", () => {
		expect(detectTaskType("summarize this document")).toBe("summarization");
		expect(detectTaskType("give me a tl;dr of this document")).toBe("summarization");
		expect(detectTaskType("recap the key points from the meeting")).toBe("summarization");
	});

	it("returns undefined for ambiguous or generic prompts", () => {
		expect(detectTaskType("hello")).toBeUndefined();
		expect(detectTaskType("yes")).toBeUndefined();
		expect(detectTaskType("do it")).toBeUndefined();
	});

	it("picks the type with more keyword matches when overlapping", () => {
		// "implement a function to calculate" has coding=2 (implement, function) + math=1 (calculate)
		expect(detectTaskType("implement a function to calculate")).toBe("coding");
		// "analyze and explain the algorithm" has research=2 (analyze, explain) + coding=1 (algorithm)
		expect(detectTaskType("analyze and explain the algorithm")).toBe("research");
	});

	it("is case-insensitive", () => {
		expect(detectTaskType("IMPLEMENT a REST API")).toBe("coding");
		expect(detectTaskType("Calculate The Integral")).toBe("math");
	});
});

// ─── resolveProfileForTaskType ───────────────────────────────────────────────

describe("resolveProfileForTaskType", () => {
	const baseProfile: RouterProfile = {
		high: { model: "anthropic/claude-sonnet-4-5" },
		medium: { model: "anthropic/claude-sonnet-4-20250514" },
		low: { model: "anthropic/claude-haiku-4-5" },
	};

	const codingProfile: RouterProfile = {
		taskType: "coding",
		high: { model: "anthropic/claude-sonnet-4-5" },
		medium: { model: "anthropic/claude-sonnet-4-20250514" },
		low: { model: "openai/gpt-4.1-nano" },
	};

	const researchProfile: RouterProfile = {
		taskType: "research",
		high: { model: "openai/gpt-5.4" },
		medium: { model: "google/gemini-3.1-pro" },
		low: { model: "google/gemini-2.0-flash" },
	};

	const config: RouterConfig = {
		defaultProfile: "auto",
		profiles: {
			auto: baseProfile,
			"my-coding": codingProfile,
			"science-work": researchProfile,
		},
	};

	it("finds a profile matching the requested task type", () => {
		expect(resolveProfileForTaskType(config, "coding")).toBe("my-coding");
		expect(resolveProfileForTaskType(config, "research")).toBe("science-work");
	});

	it("returns undefined when no profile declares that task type", () => {
		expect(resolveProfileForTaskType(config, "math")).toBeUndefined();
		expect(resolveProfileForTaskType(config, "writing")).toBeUndefined();
		expect(resolveProfileForTaskType(config, "summarization")).toBeUndefined();
	});

	it("returns undefined when no profiles exist at all", () => {
		const empty: RouterConfig = { defaultProfile: "auto", profiles: {} };
		expect(resolveProfileForTaskType(empty, "coding")).toBeUndefined();
	});

	it("picks first alphabetically when multiple profiles claim the same type", () => {
		const duped: RouterConfig = {
			defaultProfile: "auto",
			profiles: {
				"z-coding": { taskType: "coding", ...baseProfile },
				"a-coding": { taskType: "coding", ...baseProfile },
				auto: baseProfile,
			},
		};
		// profileNames sorts alphabetically → "a-coding" comes first
		expect(resolveProfileForTaskType(duped, "coding")).toBe("a-coding");
	});
});

// ─── normalizeConfig preserves taskType ──────────────────────────────────────

describe("normalizeConfig taskType preservation", () => {
	it("preserves valid taskType through normalization", () => {
		const raw: RouterConfig = {
			defaultProfile: "auto",
			profiles: {
				auto: {
					taskType: "coding",
					high: { model: "anthropic/claude-sonnet-4-5" },
					medium: { model: "anthropic/claude-sonnet-4-20250514" },
					low: { model: "anthropic/claude-haiku-4-5" },
				},
			},
		};
		const { config } = normalizeConfig(raw);
		expect(config.profiles.auto.taskType).toBe("coding");
	});

	it("drops invalid taskType values silently", () => {
		const raw: RouterConfig = {
			defaultProfile: "auto",
			profiles: {
				auto: {
					taskType: "invalid-type" as TaskType,
					high: { model: "anthropic/claude-sonnet-4-5" },
					medium: { model: "anthropic/claude-sonnet-4-20250514" },
					low: { model: "anthropic/claude-haiku-4-5" },
				},
			},
		};
		const { config } = normalizeConfig(raw);
		expect(config.profiles.auto.taskType).toBeUndefined();
	});

	it("omits taskType when not set on the profile", () => {
		const raw: RouterConfig = {
			defaultProfile: "auto",
			profiles: {
				auto: {
					high: { model: "anthropic/claude-sonnet-4-5" },
					medium: { model: "anthropic/claude-sonnet-4-20250514" },
					low: { model: "anthropic/claude-haiku-4-5" },
				},
			},
		};
		const { config } = normalizeConfig(raw);
		expect(config.profiles.auto.taskType).toBeUndefined();
	});

	it("preserves different taskType values across profiles", () => {
		const raw: RouterConfig = {
			defaultProfile: "auto",
			profiles: {
				auto: {
					high: { model: "anthropic/claude-sonnet-4-5" },
					medium: { model: "anthropic/claude-sonnet-4-20250514" },
					low: { model: "anthropic/claude-haiku-4-5" },
				},
				"my-coding": {
					taskType: "coding",
					high: { model: "anthropic/claude-sonnet-4-5" },
					medium: { model: "anthropic/claude-sonnet-4-20250514" },
					low: { model: "openai/gpt-4.1-nano" },
				},
				"science": {
					taskType: "research",
					high: { model: "openai/gpt-5.4" },
					medium: { model: "google/gemini-3.1-pro" },
					low: { model: "google/gemini-2.0-flash" },
				},
			},
		};
		const { config } = normalizeConfig(raw);
		expect(config.profiles.auto.taskType).toBeUndefined();
		expect(config.profiles["my-coding"].taskType).toBe("coding");
		expect(config.profiles["science"].taskType).toBe("research");
	});
});
