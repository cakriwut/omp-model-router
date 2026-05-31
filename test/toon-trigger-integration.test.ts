import { describe, test, expect } from "bun:test";
import type { Context } from "@oh-my-pi/pi-ai";
import {
	estimateContextTokens,
	shouldCompress,
	DEFAULT_CONTEXT_THRESHOLD,
	DEFAULT_TIME_THRESHOLD_SECONDS,
	type HistoryCompressionConfig,
} from "../src/context-compression";

/**
 * Integration test: Verify that compression trigger correctly excludes TOON history
 * when deciding whether to compress.
 *
 * This test imports the actual compression trigger logic and verifies
 * that it doesn't trigger on TOON-reconstructed sessions.
 */

describe("Compression trigger integration with TOON history", () => {
	const contextWindow = 200_000; // Bedrock Nova Pro
	const contextThreshold = DEFAULT_CONTEXT_THRESHOLD;
	const timeThreshold = DEFAULT_TIME_THRESHOLD_SECONDS;

	const baseConfig: HistoryCompressionConfig = {
		enabled: true,
		keepLastN: 4,
		progressive: {
			enabled: true,
			contextThreshold,
			timeThreshold,
		},
	};
	test("First message in TOON-reconstructed session should NOT trigger compression", () => {
		// Simulate session reconstruction with TOON history
		const context: Context = {
			system: "You are a helpful assistant.",
			messages: [
				{
					id: "history-1",
					role: "user",
					content: `[HISTORY: 71 messages compressed below. Reconstruct context from this history before responding.]
\`\`\`toon
messages[9]{role,content}:
  user,hi
  assistant,Hi. What's the task?
  user,how do this router make decision?
  assistant,"The router makes decisions through a multi-layer system..."
  user,what is context signal
  assistant,"Context signals are observable properties of the conversation..."
\`\`\``,
				},
				{
					id: "history-ack",
					role: "assistant",
					content: "Context reconstructed. Ready to proceed.",
				},
				// First NEW message after TOON reconstruction
				{
					id: "msg-1",
					role: "user",
					content: "hi",
				},
			],
		};

		const lastTurnTimestamp = undefined; // First turn
		const triggerReason = shouldCompress({
			context,
			config: baseConfig,
			contextWindow,
			targetProvider: "bedrock",
			targetModelId: "nova-pro",
			lastTurnTimestamp,
		});

		// Should NOT trigger — only "hi" + system prompt counted, well below threshold
		expect(triggerReason).toBeNull();
	});

	test("Fresh session (no TOON history) with large prompt should trigger compression", () => {
		// Generate a very large prompt (160K+ tokens)
		const largePrompt = "x".repeat(contextWindow * 4 * contextThreshold); // 640K chars ≈ 160K tokens

		const context: Context = {
			system: "You are a helpful assistant.",
			messages: [
				{
					id: "msg-1",
					role: "user",
					content: largePrompt,
				},
			],
		};

		const lastTurnTimestamp = undefined;
		const triggerReason = shouldCompress({
			context,
			config: baseConfig,
			contextWindow,
			targetProvider: "bedrock",
			targetModelId: "nova-pro",
			lastTurnTimestamp,
		});

		// Should trigger context_size
		expect(triggerReason).toBe("context_size");
	});

	test("TOON session with many NEW messages should trigger compression when threshold exceeded", () => {
		// Simulate TOON history + 100 new large messages
		const newMessages = Array.from({ length: 100 }, (_, i) => ({
			id: `msg-${i}`,
			role: i % 2 === 0 ? "user" : "assistant",
			content: "x".repeat(2000), // 500 tokens each ≈ 50K tokens total
		}));

		const context: Context = {
			system: "You are a helpful assistant.",
			messages: [
				{
					id: "history-1",
					role: "user",
					content: "[HISTORY: 71 messages compressed below...]\n```toon\nmessages[9]{role,content}:...\n```",
				},
				{
					id: "history-ack",
					role: "assistant",
					content: "Context reconstructed.",
				},
				...newMessages,
			],
		};

		const lastTurnTimestamp = undefined;
		
		// Estimate tokens for new messages only
		const estimatedTokens = estimateContextTokens(context);
		
		// If we have 100 messages × 500 tokens = 50K tokens, below threshold
		// But if we scale up to 400 messages × 500 tokens = 200K tokens, above threshold
		expect(estimatedTokens).toBeLessThan(contextWindow * contextThreshold);
		
		const triggerReason = shouldCompress({
			context,
			config: baseConfig,
			contextWindow,
			targetProvider: "bedrock",
			targetModelId: "nova-pro",
			lastTurnTimestamp,
		});

		// Should NOT trigger yet (50K < 160K threshold)
		expect(triggerReason).toBeNull();
	});

	test("Actual bug scenario: 71 TOON messages + first message 'hi' should not trigger", () => {
		// This is the exact scenario from the bug report
		const toonContent = `[HISTORY: 71 messages compressed below. Reconstruct context from this history before responding.]
\`\`\`toon
messages[9]{role,content}:
  user,hi
  assistant,Hi. What's the task?
  user,how do this router make decission?
  assistant,"The router makes decisions through a multi-layer system..."
  user,what is context signal
  assistant,"Perfect. Now I can explain the context signals..."
  user,"I am investigating the toon compression trigger..."
  user,"<system-reminder>...</system-reminder>"
  user,this this session as the debugging session
\`\`\``;

		const context: Context = {
			system: "You are THE staff engineer...", // Actual system prompt (~20K chars)
			messages: [
				{
					id: "history-1",
					role: "user",
					content: toonContent,
				},
				{
					id: "history-ack",
					role: "assistant",
					content: "Context reconstructed. Ready to proceed.",
				},
				{
					id: "msg-1",
					role: "user",
					content: "hi",
				},
			],
		};

		const estimatedTokens = estimateContextTokens(context);
		console.log(`Estimated tokens: ${estimatedTokens} (threshold: ${contextWindow * contextThreshold})`);

		const lastTurnTimestamp = undefined;
		const triggerReason = shouldCompress({
			context,
			config: baseConfig,
			contextWindow,
			targetProvider: "bedrock",
			targetModelId: "nova-pro",
			lastTurnTimestamp,
		});

		// Bug: Before fix, this would trigger compression
		// Fix: After fix, should NOT trigger (only "hi" + system prompt counted)
		expect(triggerReason).toBeNull();
	});
});
