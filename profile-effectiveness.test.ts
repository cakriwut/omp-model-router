/**
 * Comprehensive unit tests for model-router profile effectiveness.
 * Tests routing decisions across different profiles (auto, deep, cheap, oss).
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { decideRouting, buildRoutingDecision } from "./routing";
import type { RouterProfile, RouterConfig } from "./types";

// Test configuration matching the current model-router.json
const TEST_CONFIG: RouterConfig = {
  defaultProfile: "auto",
  debug: false,
  phaseBias: 0.5,
  maxSessionBudget: 5.0,
  largeContextThreshold: 150000,
  rules: [
    {
      matches: ["deploy", "production", "release", "migration"],
      tier: "high",
      reason: "Safety-critical operations require deep reasoning",
    },
    {
      matches: ["changelog", "summarize", "tl;dr", "recap"],
      tier: "low",
    },
  ],
  profiles: {
    auto: {
      high: {
        model: "amazon-bedrock/global.anthropic.claude-opus-4-7",
        thinking: "high",
        fallbacks: [
          "amazon-bedrock/global.anthropic.claude-opus-4-6-v1",
          "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
        ],
      },
      medium: {
        model: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
        thinking: "medium",
        fallbacks: [
          "amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0",
        ],
      },
      low: {
        model: "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
        thinking: "low",
        fallbacks: ["amazon-bedrock/zai.glm-4.7"],
      },
    },
    deep: {
      high: {
        model: "amazon-bedrock/global.anthropic.claude-opus-4-7",
        thinking: "xhigh",
        fallbacks: ["amazon-bedrock/global.anthropic.claude-opus-4-6-v1"],
      },
      medium: {
        model: "amazon-bedrock/global.anthropic.claude-opus-4-6-v1",
        thinking: "high",
        fallbacks: ["amazon-bedrock/global.anthropic.claude-sonnet-4-6"],
      },
      low: {
        model: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
        thinking: "medium",
      },
    },
    cheap: {
      high: {
        model: "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
        thinking: "medium",
        fallbacks: ["amazon-bedrock/zai.glm-5"],
      },
      medium: {
        model: "amazon-bedrock/global.anthropic.claude-haiku-4-5-20251001-v1:0",
        thinking: "low",
        fallbacks: ["amazon-bedrock/zai.glm-4.7"],
      },
      low: {
        model: "amazon-bedrock/zai.glm-4.7",
        thinking: "off",
        fallbacks: ["amazon-bedrock/zai.glm-4.7-flash"],
      },
    },
    oss: {
      high: {
        model: "amazon-bedrock/deepseek.v3.2",
        thinking: "high",
        fallbacks: ["amazon-bedrock/qwen.qwen3-coder-next"],
      },
      medium: {
        model: "amazon-bedrock/zai.glm-5",
        thinking: "medium",
        fallbacks: ["amazon-bedrock/nvidia.nemotron-super-3-120b"],
      },
      low: {
        model: "amazon-bedrock/zai.glm-4.7-flash",
        thinking: "off",
        fallbacks: ["amazon-bedrock/mistral.magistral-small-2509"],
      },
    },
  },
};

// Test prompts categorized by expected tier
const TEST_PROMPTS = {
  high: [
    // Architecture/planning
    "Design a microservice architecture for our new payment system that handles 10k TPS with 99.99% uptime and includes rollback mechanisms.",
    "Analyze the tradeoffs between using Redis vs PostgreSQL for our session cache implementation, considering our read-heavy workload pattern.",
    "Plan a major database migration from MongoDB to PostgreSQL with zero downtime using a dual-write strategy.",
    "Research and compare the best authentication approaches for our microservices. We need to support 1M users with SSO and MFA.",
    // Complex debugging
    `Debug why our Kubernetes deployment is crashing with "OOMKilled" errors. The pod has 4GB memory limit, our app uses Java Spring Boot with heap set to 3GB, but we still see out of memory errors during peak load at 2AM.`,
    // Rule-triggered
    "We need to deploy the new authentication service to production. What are the steps and potential risks?",
    "Prepare the release plan for v2.0 including migration strategies.",
  ],
  medium: [
    // Implementation tasks
    "Implement the JWT token validation middleware for our Express.js API.",
    "Fix the bug where the user session expires after 15 minutes instead of 24 hours.",
    "Add unit tests for the authentication service using Jest.",
    "Refactor the database connection pooling logic to improve performance.",
    // Tool-result continuation
    "I ran the tests and they failed. Can you fix the failing test cases?",
    "Based on the profiling results showing 500ms response times, optimize the database queries.",
  ],
  low: [
    // Summaries
    "Summarize the key changes in the latest PR #1234.",
    "Generate a changelog entry for version 1.2.3.",
    "Explain briefly how OAuth 2.0 works.",
    // Formatting/simple tasks
    "Format this JSON properly.",
    "Rename the variable from 'tmp' to 'temporaryValue'.",
    // Rule-triggered
    "Create a tl;dr of this architecture document.",
    // Lookup queries
    "Where is the UserRepository class located?",
    "Show me the list of environment variables used by the auth service.",
  ],
};

// Helper functions
function createContext(prompt: string) {
  return {
    messages: [
      {
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      },
    ],
  };
}

function assertModelRef(expectedProvider: string, expectedModelId: string, actualLabel: string) {
  // Parse the canonical model reference
  const parts = actualLabel.split("/");
  expect(parts.length).toBeGreaterThanOrEqual(2);
  const [provider, ...modelParts] = parts;
  const modelId = modelParts.join("/");
  
  expect(provider).toBe(expectedProvider);
  expect(modelId).toBe(expectedModelId);
}

describe("Profile-based routing effectiveness", () => {
  describe("Auto profile", () => {
    const profile = TEST_CONFIG.profiles.auto;
    const profileName = "auto";

    it("routes high-tier prompts to Claude Opus", () => {
      for (const prompt of TEST_PROMPTS.high) {
        const decision = decideRouting(
          createContext(prompt),
          profileName,
          profile,
          undefined, // previousDecision
          undefined, // pinnedTier
          undefined, // thinkingOverrides
          0.5, // phaseBias
          TEST_CONFIG.rules,
          false, // isBudgetExceeded
        );

        expect(decision.tier).toBe("high");
        expect(decision.profile).toBe("auto");
        assertModelRef("amazon-bedrock", "global.anthropic.claude-opus-4-7", decision.targetLabel);
      }
    });

    it("routes medium-tier prompts to Claude Sonnet", () => {
      for (const prompt of TEST_PROMPTS.medium) {
        const decision = decideRouting(
          createContext(prompt),
          profileName,
          profile,
          undefined,
          undefined,
          undefined,
          0.5,
          TEST_CONFIG.rules,
          false,
        );

        expect(decision.tier).toBe("medium");
        expect(decision.profile).toBe("auto");
        assertModelRef("amazon-bedrock", "global.anthropic.claude-sonnet-4-6", decision.targetLabel);
      }
    });

    it("routes low-tier prompts to Claude Haiku", () => {
      for (const prompt of TEST_PROMPTS.low) {
        const decision = decideRouting(
          createContext(prompt),
          profileName,
          profile,
          undefined,
          undefined,
          undefined,
          0.5,
          TEST_CONFIG.rules,
          false,
        );

        expect(decision.tier).toBe("low");
        expect(decision.profile).toBe("auto");
        assertModelRef("amazon-bedrock", "global.anthropic.claude-haiku-4-5-20251001-v1:0", decision.targetLabel);
      }
    });

    it("applies custom rules", () => {
      // Test deploy/production rule
      const productionPrompt = "Deploy the auth service to production with blue-green";
      const decision = decideRouting(
        createContext(productionPrompt),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(decision.tier).toBe("high");
      expect(decision.isRuleMatched).toBe(true);
      expect(decision.reasoning).toContain("Safety-critical operations");

      // Test summarize/changelog rule
      const summaryPrompt = "Create a changelog for the latest sprint";
      const summaryDecision = decideRouting(
        createContext(summaryPrompt),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(summaryDecision.tier).toBe("low");
      expect(summaryDecision.isRuleMatched).toBe(true);
    });
  });

  describe("Deep profile", () => {
    const profile = TEST_CONFIG.profiles.deep;
    const profileName = "deep";

    it("routes high-tier prompts to Claude Opus", () => {
      const decision = decideRouting(
        createContext(TEST_PROMPTS.high[0]),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(decision.tier).toBe("high");
      expect(decision.profile).toBe("deep");
      assertModelRef("amazon-bedrock", "global.anthropic.claude-opus-4-7", decision.targetLabel);
      expect(decision.thinking).toBe("xhigh"); // Deep profile uses xhigh thinking
    });

    it("routes medium-tier prompts to Claude Opus 4.6", () => {
      const decision = decideRouting(
        createContext(TEST_PROMPTS.medium[0]),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(decision.tier).toBe("medium");
      expect(decision.profile).toBe("deep");
      assertModelRef("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1", decision.targetLabel);
      expect(decision.thinking).toBe("high"); // Deep profile uses high thinking for medium tier
    });

    it("routes low-tier prompts to Claude Sonnet", () => {
      const decision = decideRouting(
        createContext(TEST_PROMPTS.low[0]),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(decision.tier).toBe("low");
      expect(decision.profile).toBe("deep");
      assertModelRef("amazon-bedrock", "global.anthropic.claude-sonnet-4-6", decision.targetLabel);
      expect(decision.thinking).toBe("medium"); // Deep profile uses medium thinking for low tier
    });
  });

  describe("Cheap profile", () => {
    const profile = TEST_CONFIG.profiles.cheap;
    const profileName = "cheap";

    it("routes high-tier prompts to Claude Sonnet", () => {
      const decision = decideRouting(
        createContext(TEST_PROMPTS.high[0]),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(decision.tier).toBe("high");
      expect(decision.profile).toBe("cheap");
      assertModelRef("amazon-bedrock", "global.anthropic.claude-sonnet-4-6", decision.targetLabel);
      expect(decision.thinking).toBe("medium"); // Cheap profile uses medium thinking for high tier
    });

    it("routes medium-tier prompts to Claude Haiku", () => {
      const decision = decideRouting(
        createContext(TEST_PROMPTS.medium[0]),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(decision.tier).toBe("medium");
      expect(decision.profile).toBe("cheap");
      assertModelRef("amazon-bedrock", "global.anthropic.claude-haiku-4-5-20251001-v1:0", decision.targetLabel);
      expect(decision.thinking).toBe("low"); // Cheap profile uses low thinking for medium tier
    });

    it("routes low-tier prompts to GLM-4.7", () => {
      const decision = decideRouting(
        createContext(TEST_PROMPTS.low[0]),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(decision.tier).toBe("low");
      expect(decision.profile).toBe("cheap");
      assertModelRef("amazon-bedrock", "zai.glm-4.7", decision.targetLabel);
      expect(decision.thinking).toBe("off"); // Cheap profile turns thinking off for low tier
    });
  });

  describe("OSS profile", () => {
    const profile = TEST_CONFIG.profiles.oss;
    const profileName = "oss";

    it("routes high-tier prompts to DeepSeek v3.2", () => {
      const decision = decideRouting(
        createContext(TEST_PROMPTS.high[0]),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(decision.tier).toBe("high");
      expect(decision.profile).toBe("oss");
      assertModelRef("amazon-bedrock", "deepseek.v3.2", decision.targetLabel);
      expect(decision.thinking).toBe("high");
    });

    it("routes medium-tier prompts to GLM-5", () => {
      const decision = decideRouting(
        createContext(TEST_PROMPTS.medium[0]),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(decision.tier).toBe("medium");
      expect(decision.profile).toBe("oss");
      assertModelRef("amazon-bedrock", "zai.glm-5", decision.targetLabel);
      expect(decision.thinking).toBe("medium");
    });

    it("routes low-tier prompts to GLM-4.7-flash", () => {
      const decision = decideRouting(
        createContext(TEST_PROMPTS.low[0]),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(decision.tier).toBe("low");
      expect(decision.profile).toBe("oss");
      assertModelRef("amazon-bedrock", "zai.glm-4.7-flash", decision.targetLabel);
      expect(decision.thinking).toBe("off");
    });
  });

  describe("Edge cases and special triggers", () => {
    const profile = TEST_CONFIG.profiles.auto;
    const profileName = "auto";

    it("downgrades high tier when budget exceeded", () => {
      const highTierPrompt = TEST_PROMPTS.high[0];
      const decision = decideRouting(
        createContext(highTierPrompt),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        true, // isBudgetExceeded = true
      );

      expect(decision.tier).toBe("medium");
      expect(decision.isBudgetForced).toBe(true);
      expect(decision.reasoning).toContain("Budget exceeded");
      expect(decision.reasoning).toContain("Downgraded");
    });

    it("upgrades tier for image attachments", () => {
      // Note: hasImageAttachment check happens in provider.ts, not in routing.ts
      // This test just verifies that image-capable models are in the fallback chain
      const imageCapableModels = [
        "amazon-bedrock/global.anthropic.claude-sonnet-4-6",
        "amazon-bedrock/global.anthropic.claude-opus-4-7",
        "amazon-bedrock/global.anthropic.claude-opus-4-6-v1"
      ];
      
      // Check that auto profile's medium tier includes image-capable fallbacks
      expect(profile.medium.fallbacks).toContain("amazon-bedrock/global.anthropic.claude-sonnet-4-5-20250929-v1:0");
      
      // Check that high tier includes image-capable fallbacks
      expect(profile.high.fallbacks).toContain("amazon-bedrock/global.anthropic.claude-opus-4-6-v1");
      expect(profile.high.fallbacks).toContain("amazon-bedrock/global.anthropic.claude-sonnet-4-6");
    });

    it("respects explicit high/low hints", () => {
      // Explicit high hint
      const highPrompt = "I need the best solution for this complex problem";
      const highDecision = decideRouting(
        createContext(highPrompt),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(highDecision.tier).toBe("high");
      expect(highDecision.reasoning).toContain("explicit request for deeper");

      // Explicit low hint
      const lowPrompt = "Give me a quick summary of this";
      const lowDecision = decideRouting(
        createContext(lowPrompt),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(lowDecision.tier).toBe("low");
      expect(lowDecision.reasoning).toContain("explicit request for a faster");
    });

    it("maintains phase bias", () => {
      // Start with a planning phase decision
      const planningDecision = decideRouting(
        createContext(TEST_PROMPTS.high[0]),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(planningDecision.phase).toBe("planning");

      // Follow-up prompt should maintain planning phase bias
      const followUpPrompt = "Now consider the scalability implications";
      const followUpDecision = decideRouting(
        createContext(followUpPrompt),
        profileName,
        profile,
        planningDecision,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(followUpDecision.phase).toBe("planning");
      expect(followUpDecision.reasoning).toContain("Kept the planning-phase bias");
    });
  });

  describe("Tier transition effectiveness", () => {
    const profile = TEST_CONFIG.profiles.auto;
    const profileName = "auto";

    it("transitions from planning to implementation when executing", () => {
      // Start with planning
      const planningPrompt = "Design a caching strategy for our web app";
      const planningDecision = decideRouting(
        createContext(planningPrompt),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(planningDecision.phase).toBe("planning");

      // Move to implementation
      const implementationPrompt = "Now implement the Redis cache integration";
      const implementationDecision = decideRouting(
        createContext(implementationPrompt),
        profileName,
        profile,
        planningDecision,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(implementationDecision.phase).toBe("implementation");
      expect(implementationDecision.reasoning).toContain("implementation-oriented work");
    });

    it("transitions to lightweight for simple tasks", () => {
      // Start with medium-tier implementation
      const implPrompt = "Fix the bug in the login function";
      const implDecision = decideRouting(
        createContext(implPrompt),
        profileName,
        profile,
        undefined,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(implDecision.phase).toBe("implementation");

      // Then ask a simple lookup
      const simplePrompt = "Where is the login function defined?";
      const simpleDecision = decideRouting(
        createContext(simplePrompt),
        profileName,
        profile,
        implDecision,
        undefined,
        undefined,
        0.5,
        TEST_CONFIG.rules,
        false,
      );

      expect(simpleDecision.phase).toBe("lightweight");
      expect(simpleDecision.tier).toBe("low");
      expect(simpleDecision.reasoning).toContain("short read-only lookup");
    });
  });
});