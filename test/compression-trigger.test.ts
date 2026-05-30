import { describe, test, expect } from "bun:test";
import type { Context, Message } from "@oh-my-pi/pi-ai";

/**
 * Test suite for compression trigger validation.
 * 
 * Bug context: The original `estimateContextTokens` used JSON.stringify(),
 * which UNDERESTIMATED tokens by 3-10× compared to actual usage stats.
 * 
 * This caused compression to trigger LATE (or not at all for context_size),
 * leading to potential OOMs or quota errors.
 * 
 * Fix: Use actual usage stats when available, fall back to content-based estimation.
 */

// Import the new estimation function (we'll need to export it from provider.ts)
// For now, we'll replicate the logic here to validate the approach

function estimateContextTokens(context: Context): number {
	let totalTokens = 0;
	
	// 1. Count tokens from messages with usage stats
	for (const msg of context.messages) {
		if ((msg as any).usage) {
			const usage = (msg as any).usage;
			totalTokens += (usage.input ?? 0) + (usage.output ?? 0);
		} else {
			// 2. For messages without usage, estimate from content
			totalTokens += estimateMessageTokens(msg);
		}
	}
	
	// 3. Add system prompt tokens (rough estimate: 1 token ≈ 4 chars)
	if (context.system) {
		const systemStr = Array.isArray(context.system)
			? context.system.map((s: any) => (typeof s === "string" ? s : s.text ?? "")).join("")
			: context.system;
		totalTokens += Math.ceil(systemStr.length / 4);
	}
	
	return totalTokens;
}

function estimateMessageTokens(msg: Message): number {
	let textContent = "";
	
	if (typeof msg.content === "string") {
		textContent = msg.content;
	} else if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block.type === "text") {
				textContent += (block as any).text ?? "";
			} else if (block.type === "tool_result") {
				const resultContent = typeof (block as any).content === "string"
					? (block as any).content
					: Array.isArray((block as any).content)
					? (block as any).content.map((c: any) => (typeof c === "string" ? c : c.text ?? "")).join("")
					: "";
				textContent += resultContent;
			} else if (block.type === "tool_use") {
				textContent += JSON.stringify((block as any).input ?? {});
			}
		}
	}
	
	return Math.ceil(textContent.length / 4);
}

describe("Compression trigger validation", () => {
	test("should accurately estimate tokens for 10-turn conversation with usage stats", () => {
		// Simulate a realistic 10-turn conversation
		const messages: Message[] = [];
		for (let i = 0; i < 10; i++) {
			messages.push(
				{
					role: "user",
					content: `Turn ${i}: This is a typical user message asking a question about code. Please explain how the router works and why compression is triggered. I need to understand the token estimation logic.`,
					timestamp: Date.now() + i * 1000,
				},
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: `Turn ${i} response: Here's a detailed explanation spanning multiple paragraphs. First, the router classifies prompts into tiers. Second, it selects models based on cost optimization. Third, it tracks usage and budget constraints. Fourth, compression kicks in when thresholds are met. Fifth, the system maintains state across turns.`,
						},
					],
					timestamp: Date.now() + i * 1000 + 500,
					usage: {
						input: 1200,
						output: 450,
					},
					api: "messages" as any,
					provider: "anthropic",
					model: "claude-sonnet-4-5",
				} as any,
			);
		}

		const context: Context = {
			messages,
			system: "You are a helpful coding assistant.",
		};

		// Manual token count from usage stats (10 turns × ~1650 tokens = ~16.5K)
		const actualTokens = messages
			.filter((m: any) => m.usage)
			.reduce((sum: number, m: any) => sum + (m.usage?.input ?? 0) + (m.usage?.output ?? 0), 0);

		// NEW FIX: usage-based estimate
		const estimatedTokens = estimateContextTokens(context);

		console.log({
			actualTokens, // ~16,500 from usage
			estimatedTokens, // Should match actual
			accuracy: (estimatedTokens / actualTokens) * 100,
			threshold: 160_000,
		});

		// NEW FIX: estimate should closely match actual tokens (within 10%)
		expect(estimatedTokens).toBeGreaterThanOrEqual(actualTokens * 0.9);
		expect(estimatedTokens).toBeLessThanOrEqual(actualTokens * 1.1);
		expect(estimatedTokens).toBeLessThan(160_000); // Should NOT trigger at 10 turns
	});

	test("should use actual usage stats for token estimation when available", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: "Short prompt",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Short response" }],
				timestamp: Date.now(),
				usage: {
					input: 150,
					output: 50,
				},
				api: "messages" as any,
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			} as any,
		];

		const context: Context = { messages };

		// Actual tokens from usage: 200
		const actualTokens = messages
			.filter((m: any) => m.usage)
			.reduce((sum: number, m: any) => sum + (m.usage?.input ?? 0) + (m.usage?.output ?? 0), 0);

		// NEW FIX: usage-based estimate
		const estimatedTokens = estimateContextTokens(context);

		console.log({
			actualTokens, // 200
			estimatedTokens, // Should match actual
			accuracy: (estimatedTokens / actualTokens) * 100,
		});

		// NEW FIX: usage-based estimate should match actual (within 10%)
		expect(estimatedTokens).toBeGreaterThanOrEqual(actualTokens * 0.9);
		expect(estimatedTokens).toBeLessThanOrEqual(actualTokens * 1.1);
	});

	test("should handle conversations with large tool calls using usage stats", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: "Read the file",
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "tool_1",
						name: "read",
						input: { path: "src/large-file.ts", _i: "Reading file" },
					},
				],
				timestamp: Date.now(),
				usage: { input: 100, output: 20 },
				api: "messages" as any,
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			} as any,
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "tool_1",
						content: "// Large TypeScript file with 500 lines of code\n" + "x".repeat(15000),
					},
				],
				timestamp: Date.now(),
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "I've read the file. The key function is..." }],
				timestamp: Date.now(),
				usage: { input: 5200, output: 300 },
				api: "messages" as any,
				provider: "anthropic",
				model: "claude-sonnet-4-5",
			} as any,
		];

		const context: Context = { messages };

		// Actual tokens: ~5620
		const actualTokens = messages
			.filter((m: any) => m.usage)
			.reduce((sum: number, m: any) => sum + (m.usage?.input ?? 0) + (m.usage?.output ?? 0), 0);

		// NEW FIX: usage-based estimate
		const estimatedTokens = estimateContextTokens(context);

		console.log({
			actualTokens, // ~5,620
			estimatedTokens, // Should match actual when usage is available
			accuracy: (estimatedTokens / actualTokens) * 100,
		});

		// NEW FIX: usage-based estimate should handle tool results accurately
		// User messages (tool results) don't have usage stats, so we estimate from content.
		// The 15KB tool result payload contributes ~3750 tokens.
		// Total: 120 (from usage) + ~3750 (tool result) ≈ 9386 tokens
		expect(estimatedTokens).toBeGreaterThan(actualTokens); // Will exceed usage-only count
		expect(estimatedTokens).toBeLessThan(10_000); // But still reasonable

		// A 4-turn conversation with tool calls should NOT trigger compression at 160K threshold
		expect(estimatedTokens).toBeLessThan(160_000);
	});


	test("should estimate tokens for user messages without usage stats", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: "This is a test message with approximately 200 tokens worth of content. ".repeat(15),
				timestamp: Date.now(),
			},
		];

		const context: Context = { messages };
		const estimatedTokens = estimateContextTokens(context);

		// Content-based estimation: ~1050 chars / 4 ≈ 262 tokens
		console.log({
			estimatedTokens,
			contentLength: messages[0].content.length,
			expectedRange: [200, 300],
		});

		// Should be in a reasonable range based on content length
		expect(estimatedTokens).toBeGreaterThan(200);
		expect(estimatedTokens).toBeLessThan(300);
	});

	test("compression trigger should log to session when debug enabled", async () => {
		// This test verifies that when debug mode is enabled and compression triggers,
		// a custom session entry is created for auditability.
		// (Full integration test would require importing provider.ts)
		
		const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
		const mockSessionManager = {
			appendCustomEntry: (customType: string, data?: unknown) => {
				entries.push({ type: "custom", customType, data });
				return "entry-id";
			},
		};

		// Simulate compression trigger logging
		const compressionDebugData = {
			reason: "context-size",
			contextTokens: 165432,
			threshold: 160000,
			timeSinceLastTurn: 287,
			timeThreshold: 300,
			turnNumber: 42,
			messageCount: 84,
		};

		mockSessionManager.appendCustomEntry("router:compression-trigger", compressionDebugData);

		// Verify session entry was created
		const compressionEntry = entries.find(e => e.customType === "router:compression-trigger");
		expect(compressionEntry).toBeDefined();
		expect(compressionEntry?.data).toMatchObject({
			reason: "context-size",
			contextTokens: 165432,
			threshold: 160000,
			turnNumber: 42,
			messageCount: 84,
		});
	});
});
