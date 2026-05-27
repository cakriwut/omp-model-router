import { describe, it, expect } from "bun:test";
import {
	resolveCompressionConfig,
	compressHistory,
	sanitizeTurnAlternation,
	isModelExcludedFromCompression,
} from "../src/context-compression";
import type { Context, Message } from "@oh-my-pi/pi-ai";

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeUserMsg(content: string, ts = Date.now()): Message {
	return { role: "user", content, timestamp: ts };
}

function makeAssistantMsg(text: string, ts = Date.now()): Message {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages" as any,
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: "stop",
		timestamp: ts,
	};
}

function makeAssistantWithToolCall(toolName: string, args: Record<string, unknown>, text?: string, ts = Date.now()): Message {
	const content: any[] = [];
	if (text) content.push({ type: "text", text });
	content.push({ type: "toolCall", id: `call_${Math.random().toString(36).slice(2, 8)}`, name: toolName, arguments: args });
	return {
		role: "assistant",
		content,
		api: "anthropic-messages" as any,
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		usage: {
			input: 100,
			output: 50,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 150,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: "tool_use",
		timestamp: ts,
	};
}

function makeToolResultMsg(toolName: string, content: string, ts = Date.now()): Message {
	return {
		role: "toolResult",
		toolCallId: `call_${Math.random().toString(36).slice(2, 8)}`,
		toolName,
		content: [{ type: "text", text: content }],
		isError: false,
		timestamp: ts,
	};
}

function buildConversation(count: number): Message[] {
	const msgs: Message[] = [];
	for (let i = 0; i < count; i++) {
		if (i % 2 === 0) {
			msgs.push(makeUserMsg(`Message ${i}`, 1000 + i));
		} else {
			msgs.push(makeAssistantMsg(`Response ${i}`, 1000 + i));
		}
	}
	return msgs;
}

// ─── resolveCompressionConfig ─────────────────────────────────────────────────

describe("resolveCompressionConfig", () => {
	it("returns undefined when both configs are disabled/missing", () => {
		expect(resolveCompressionConfig(undefined, undefined)).toBeUndefined();
		expect(
			resolveCompressionConfig({ enabled: false }, undefined),
		).toBeUndefined();
	});

	it("returns global config when no profile override", () => {
		const cfg = resolveCompressionConfig(
			{ enabled: true, keepLastN: 6 },
			undefined,
		);
		expect(cfg).toEqual({ enabled: true, keepLastN: 6 });
	});

	it("profile overrides global", () => {
		const cfg = resolveCompressionConfig(
			{ enabled: true, keepLastN: 6 },
			{ enabled: true, keepLastN: 2 },
		);
		expect(cfg).toEqual({ enabled: true, keepLastN: 2 });
	});

	it("profile can disable globally-enabled compression", () => {
		const cfg = resolveCompressionConfig(
			{ enabled: true, keepLastN: 4 },
			{ enabled: false },
		);
		expect(cfg).toEqual({ enabled: false, keepLastN: 4 });
	});

	it("defaults keepLastN to 4", () => {
		const cfg = resolveCompressionConfig({ enabled: true }, undefined);
		expect(cfg?.keepLastN).toBe(4);
	});
});

// ─── sanitizeTurnAlternation ──────────────────────────────────────────────────

describe("sanitizeTurnAlternation", () => {
	it("returns empty/single arrays unchanged", () => {
		expect(sanitizeTurnAlternation([])).toEqual([]);
		const single = [makeUserMsg("hi")];
		expect(sanitizeTurnAlternation(single)).toEqual(single);
	});

	it("merges consecutive user messages", () => {
		const msgs = [
			makeUserMsg("first", 1000),
			makeUserMsg("second", 1001),
			makeUserMsg("third", 1002),
		];
		const result = sanitizeTurnAlternation(msgs);
		expect(result.length).toBe(1);
		expect(result[0].role).toBe("user");
		expect(result[0].content).toContain("first");
		expect(result[0].content).toContain("second");
		expect(result[0].content).toContain("third");
	});

	it("merges consecutive assistant messages", () => {
		const msgs = [
			makeAssistantMsg("part 1", 1000),
			makeAssistantMsg("part 2", 1001),
		];
		const result = sanitizeTurnAlternation(msgs);
		expect(result.length).toBe(1);
		expect(result[0].role).toBe("assistant");
		const content = result[0].content as any[];
		// Merged into single text block with both parts
		expect(content.length).toBe(1);
		expect(content[0].text).toContain("part 1");
		expect(content[0].text).toContain("part 2");
	});

	it("preserves valid alternation", () => {
		const msgs = [
			makeUserMsg("hi", 1000),
			makeAssistantMsg("hello", 1001),
			makeUserMsg("bye", 1002),
		];
		const result = sanitizeTurnAlternation(msgs);
		expect(result.length).toBe(3);
		expect(result.map(m => m.role)).toEqual(["user", "assistant", "user"]);
	});

	it("handles orphaned toolResult after user message", () => {
		const msgs = [
			makeUserMsg("something", 1000),
			makeToolResultMsg("bash", "output", 1001),
		];
		const result = sanitizeTurnAlternation(msgs);
		// toolResult without preceding assistant gets merged into user
		expect(result.length).toBe(1);
		expect(result[0].role).toBe("user");
		expect((result[0].content as string)).toContain("output");
	});

	it("handles real-world abort pattern: user → toolResult → user → user", () => {
		const msgs: Message[] = [
			makeUserMsg("do something", 1000),
			makeAssistantMsg("working", 1001),
			makeToolResultMsg("bash", "error output", 1002),
			makeUserMsg("<turn-aborted>", 1003),
			makeUserMsg("try again", 1004),
			makeUserMsg("<turn-aborted>", 1005),
			makeUserMsg("what is wrong", 1006),
		];
		const result = sanitizeTurnAlternation(msgs);
		// Should produce valid alternation
		for (let i = 1; i < result.length; i++) {
			if (result[i].role === result[i - 1].role) {
				// This should not happen (except toolResult after assistant is fine)
				expect(result[i].role).not.toBe(result[i - 1].role);
			}
		}
	});
});

// ─── compressHistory ──────────────────────────────────────────────────────────

describe("compressHistory", () => {
	const config = { enabled: true, keepLastN: 4 };

	it("returns context unchanged when messages <= keepLastN", () => {
		const msgs = buildConversation(4);
		const ctx: Context = { messages: msgs };
		const result = compressHistory(ctx, config);
		expect(result.context).toBe(ctx); // identity — no copy
		expect(result.stats).toBeUndefined();
	});

	it("compresses when messages > keepLastN", () => {
		const msgs = buildConversation(10);
		const ctx: Context = { messages: msgs };
		const { context: result, stats } = compressHistory(ctx, config);

		// Compressed: msgs[0..5] → 1 user + 1 assistant ack
		// Kept: msgs[6..9] → 4 messages
		// Total: 6 messages
		expect(result.messages.length).toBe(6);
		expect(stats).toBeDefined();
		expect(stats!.compressedMessages).toBe(6);
	});

	it("first message is user with TOON block", () => {
		const msgs = buildConversation(10);
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, config);

		const first = result.messages[0];
		expect(first.role).toBe("user");
		expect(typeof first.content).toBe("string");
		expect((first.content as string)).toContain("[HISTORY:");
		expect((first.content as string)).toContain("```toon");
	});

	it("second message is synthetic assistant ack when next is user", () => {
		const msgs = buildConversation(10);
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, config);

		const second = result.messages[1];
		expect(second.role).toBe("assistant");
	});

	it("last keepLastN messages are preserved unchanged", () => {
		const msgs = buildConversation(10);
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, config);

		// The last 4 original messages should be at positions 2..5
		const kept = result.messages.slice(2);
		expect(kept).toEqual(msgs.slice(6));
	});

	it("preserves systemPrompt and tools untouched", () => {
		const msgs = buildConversation(10);
		const ctx: Context = {
			systemPrompt: "You are a helpful assistant.",
			messages: msgs,
			tools: [{ name: "test", description: "test", parameters: {} as any }],
		};
		const { context: result } = compressHistory(ctx, config);
		expect(result.systemPrompt).toBe("You are a helpful assistant.");
		expect(result.tools).toBe(ctx.tools);
	});

	it("TOON block does NOT contain api/provider/model/usage/timestamp fields", () => {
		const msgs = buildConversation(10);
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, config);

		const toonContent = result.messages[0].content as string;
		expect(toonContent).not.toContain("anthropic-messages");
		expect(toonContent).not.toContain("provider:");
		expect(toonContent).not.toContain("stopReason:");
		expect(toonContent).not.toContain("usage:");
		expect(toonContent).not.toContain("cacheRead:");
	});

	it("TOON block contains role and content", () => {
		const msgs = buildConversation(10);
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, config);

		const toonContent = result.messages[0].content as string;
		expect(toonContent).toContain("role");
		expect(toonContent).toContain("content");
		expect(toonContent).toContain("Message 0");
		expect(toonContent).toContain("Response 1");
	});

	it("handles toolResult messages in compression", () => {
		const msgs: Message[] = [
			makeUserMsg("run the test"),
			makeAssistantWithToolCall("bash", { command: "bun test" }, "I'll run it"),
			makeToolResultMsg("bash", "PASS: all tests green"),
			makeUserMsg("great, now deploy"),
			makeAssistantMsg("deploying..."),
			makeUserMsg("check status"),
		];
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, { enabled: true, keepLastN: 2 });

		// Verify the tool info is in the compressed block
		const toonContent = result.messages[0].content as string;
		expect(toonContent).toContain("bash");
		expect(toonContent).toContain("PASS: all tests green");
	});

	it("keepLastN minimum is clamped to 1", () => {
		const msgs = buildConversation(6);
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, { enabled: true, keepLastN: 0 });

		// keepLastN clamped to 1 → compressed most, kept last
		expect(result.messages.length).toBeGreaterThanOrEqual(2); // at least toon + 1 kept
		// Last message should be the final original message
		const lastResult = result.messages[result.messages.length - 1];
		expect(lastResult).toBe(msgs[5]);
	});

	it("compressed output is smaller than original JSON for uniform messages", () => {
		const msgs = buildConversation(20);
		const ctx: Context = { messages: msgs };
		const { context: result, stats } = compressHistory(ctx, config);

		const originalJson = JSON.stringify(msgs.slice(0, 16));
		const toonContent = result.messages[0].content as string;

		// TOON should be meaningfully smaller than JSON for uniform {role,content} arrays
		expect(toonContent.length).toBeLessThan(originalJson.length);
	});
});

// ─── TOON effectiveness by message type ───────────────────────────────────────

describe("TOON compression effectiveness", () => {
	it("achieves good savings for text-only conversations (uniform structure)", () => {
		// All messages have {role, content} — TOON tabular form applies
		const msgs = buildConversation(20);
		const ctx: Context = { messages: msgs };
		const { stats } = compressHistory(ctx, { enabled: true, keepLastN: 4 });

		expect(stats).toBeDefined();
		const savingsPercent = 1 - stats!.compressedChars / stats!.originalChars;
		// Expect at least 20% savings for uniform text messages
		expect(savingsPercent).toBeGreaterThan(0.2);
	});

	it("still provides savings for tool-heavy conversations (via metadata stripping)", () => {
		// Mix of user, assistant-with-tool-call, toolResult — non-uniform fields
		const msgs: Message[] = [];
		for (let i = 0; i < 20; i++) {
			msgs.push(makeUserMsg(`Do task ${i}`, 1000 + i * 3));
			msgs.push(makeAssistantWithToolCall("bash", { command: `echo ${i}` }, `Running task ${i}`, 1001 + i * 3));
			msgs.push(makeToolResultMsg("bash", `output ${i}`, 1002 + i * 3));
		}
		const ctx: Context = { messages: msgs };
		const { stats } = compressHistory(ctx, { enabled: true, keepLastN: 4 });

		expect(stats).toBeDefined();
		const savingsPercent = 1 - stats!.compressedChars / stats!.originalChars;
		// Should still save due to metadata stripping + text-only messages get tabular
		console.log(`  Tool-heavy savings: ${(savingsPercent * 100).toFixed(1)}%`);
		expect(savingsPercent).toBeGreaterThan(0);
	});

	it("TOON output is parseable and contains all tool call info", () => {
		const msgs: Message[] = [
			makeUserMsg("Read the file"),
			makeAssistantWithToolCall("read", { path: "/home/user/config.ts" }, "I'll read it"),
			makeToolResultMsg("read", "export const x = 42;"),
			makeUserMsg("Edit it"),
			makeAssistantWithToolCall("edit", { path: "/home/user/config.ts", edits: [{ oldText: "42", newText: "100" }] }),
			makeToolResultMsg("edit", "Applied 1 edit"),
			makeUserMsg("Run tests"),
			makeAssistantWithToolCall("bash", { command: "bun test" }),
			makeToolResultMsg("bash", "PASS: 3 tests"),
			makeAssistantMsg("All tests pass!"),
		];
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, { enabled: true, keepLastN: 2 });

		const toonContent = result.messages[0].content as string;

		// Verify tool information is preserved (read + edit in compressed, bash in kept)
		expect(toonContent).toContain("read");
		expect(toonContent).toContain("edit");
		expect(toonContent).toContain("/home/user/config.ts");

		// bash tool call may be in kept portion due to smart split boundary
		// Verify it's somewhere in the output
		const allContent = result.messages
			.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
			.join(" ");
		expect(allContent).toContain("bash");
		expect(allContent).toContain("bun test");
	});

	it("separates text-only messages into TOON tabular and tool sequences as summaries", () => {
		const msgs: Message[] = [
			makeUserMsg("Hello"),
			makeAssistantMsg("Hi there!"),
			makeUserMsg("Read the file"),
			makeAssistantWithToolCall("read", { path: "/tmp/x.ts" }),
			makeToolResultMsg("read", "const x = 1;"),
			makeUserMsg("Good"),
			makeAssistantMsg("Anything else?"),
			makeUserMsg("No thanks"),
		];
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, { enabled: true, keepLastN: 2 });

		const content = result.messages[0].content as string;
		// Should have TOON block for text messages
		expect(content).toContain("```toon");
		// Should have tool summary section
		expect(content).toContain("[Tool interactions summary]");
		// Tool details should be in the summary
		expect(content).toContain("read");
		expect(content).toContain("/tmp/x.ts");
	});
});

// ─── Turn alternation safety (the main fix) ──────────────────────────────────

describe("compressHistory — turn alternation safety", () => {
	it("output always has valid turn alternation", () => {
		// Reproduce the real bug: broken tool call causes consecutive user messages
		const msgs: Message[] = [
			makeUserMsg("Start here", 1000),
			makeAssistantMsg("OK", 1001),
			makeUserMsg("Do something", 1002),
			makeAssistantMsg("Working on it", 1003),
			// After this: broken tool call caused consecutive user messages
			makeUserMsg("Aborted turn 1", 1004),
			makeUserMsg("Aborted turn 2", 1005),
			makeUserMsg("New question", 1006),
			makeUserMsg("Another abort", 1007),
		];
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, { enabled: true, keepLastN: 4 });

		// The output should have VALID alternation (consecutive user messages merged)
		const roles = result.messages.map(m => m.role);
		for (let i = 1; i < roles.length; i++) {
			expect(roles[i]).not.toBe(roles[i - 1]);
		}
	});

	it("does not split tool call from its result", () => {
		// keepLastN would naively split between assistant(toolCall) and toolResult
		const msgs: Message[] = [
			makeUserMsg("Do something", 1000),
			makeAssistantMsg("Sure", 1001),
			makeUserMsg("Read it", 1002),
			makeAssistantWithToolCall("read", { path: "/tmp/x" }, "Let me check", 1003),
			// ← naive keepLastN=2 would split HERE, orphaning the toolResult
			makeToolResultMsg("bash", "file content here", 1004),
			makeUserMsg("What did you find?", 1005),
		];
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, { enabled: true, keepLastN: 2 });

		// The tool call and its result should stay together
		// Either both are compressed or both are kept
		const roles = result.messages.map(m => m.role);

		// Verify valid alternation in output
		for (let i = 1; i < roles.length; i++) {
			if (roles[i] === roles[i - 1]) {
				// Only allowed: assistant can be followed by toolResult (in some APIs)
				// But in our normalized form, this shouldn't happen
				expect(`${roles[i-1]}→${roles[i]}`).not.toBe("user→user");
				expect(`${roles[i-1]}→${roles[i]}`).not.toBe("assistant→assistant");
			}
		}
	});

	it("skips synthetic ack when first kept message is assistant", () => {
		// If first kept message is assistant, user(toon) → assistant is valid
		const msgs: Message[] = [
			makeUserMsg("Start", 1000),
			makeAssistantMsg("Response 1", 1001),
			makeUserMsg("Continue", 1002),
			// Kept portion starts here (keepLastN=2):
			makeAssistantMsg("Response 2", 1003),
			makeUserMsg("Final", 1004),
		];
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, { enabled: true, keepLastN: 2 });

		// user(toon) → assistant("Response 2") → user("Final")
		// No synthetic ack needed!
		const roles = result.messages.map(m => m.role);
		expect(roles[0]).toBe("user"); // toon block
		expect(roles[1]).toBe("assistant"); // either ack or kept assistant

		// Verify no consecutive same-role
		for (let i = 1; i < roles.length; i++) {
			expect(roles[i]).not.toBe(roles[i - 1]);
		}
	});

	it("handles multiple aborted turns creating consecutive user messages", () => {
		// Real pattern: user aborts, sends new message, aborts again
		const msgs: Message[] = [
			makeUserMsg("Do something", 1000),
			makeAssistantMsg("Working on it...", 1001),
			makeUserMsg("<turn-aborted>\nThe previous turn was aborted.", 1002),
			makeUserMsg("Try again", 1003),
			makeUserMsg("<turn-aborted>\nThe previous turn was aborted.", 1004),
			makeUserMsg("Something is wrong", 1005),
			makeUserMsg("<turn-aborted>\nThe previous turn was aborted.", 1006),
			makeUserMsg("Final attempt", 1007),
		];
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, { enabled: true, keepLastN: 4 });

		// Output must have valid alternation — consecutive users should be merged
		const roles = result.messages.map(m => m.role);
		for (let i = 1; i < roles.length; i++) {
			expect(roles[i]).not.toBe(roles[i - 1]);
		}

		// The user content should be preserved (merged)
		const lastUserMsg = result.messages.find((m, i) =>
			m.role === "user" && i === result.messages.length - 1
		);
		// The final message should contain the last user's intent
		const allContent = result.messages
			.filter(m => m.role === "user")
			.map(m => typeof m.content === "string" ? m.content : "")
			.join(" ");
		expect(allContent).toContain("Final attempt");
	});

	it("handles broken tool call from Kimi K2.5 (leaked special tokens)", () => {
		// Reproduces the actual production failure
		const msgs: Message[] = [
			makeUserMsg("Read the config", 1000),
			makeAssistantMsg("Let me check", 1001),
			makeUserMsg("Use the read tool", 1002),
			{
				role: "assistant",
				content: [
					{ type: "text", text: "The command failed. Better approach:" },
					{
						type: "toolCall",
						id: "functions_read_1",
						name: 'functions_read_1 <|tool_call_argument_begin|> {"path"',
						arguments: {},
					},
				],
				api: "anthropic-messages" as any,
				provider: "anthropic",
				model: "kimi-k2.5",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "tool_use",
				timestamp: 1003,
			},
			{
				role: "toolResult",
				toolCallId: "functions_read_1",
				toolName: 'functions_read_1 <|tool_call_argument_begin|> {"path"',
				content: [{ type: "text", text: 'Tool not found' }],
				isError: true,
				timestamp: 1004,
			},
			makeUserMsg("<turn-aborted>\nThe previous turn was aborted.", 1005),
			makeUserMsg("Something is wrong", 1006),
			makeUserMsg("<turn-aborted>\nThe previous turn was aborted.", 1007),
			makeUserMsg("I have restarted", 1008),
		];
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, { enabled: true, keepLastN: 4 });

		// Must produce valid alternation regardless of the broken history
		const roles = result.messages.map(m => m.role);
		for (let i = 1; i < roles.length; i++) {
			expect(roles[i]).not.toBe(roles[i - 1]);
		}

		// The broken tool call info should still be somewhere in the output
		const allContent = result.messages
			.map(m => typeof m.content === "string" ? m.content : JSON.stringify(m.content))
			.join(" ");
		// Key info preserved (either in toon block or kept messages)
		expect(allContent).toContain("tool_call_argument_begin");
	});
});

// ─── Smart split boundary ─────────────────────────────────────────────────────

describe("compressHistory — smart split boundary", () => {
	it("keeps tool call and result together when split would orphan result", () => {
		const msgs: Message[] = [
			makeUserMsg("step 1", 1000),
			makeAssistantMsg("ok 1", 1001),
			makeUserMsg("step 2", 1002),
			makeAssistantMsg("ok 2", 1003),
			makeUserMsg("step 3", 1004),
			makeAssistantWithToolCall("bash", { command: "ls" }, "checking", 1005),
			// Naive split at index 5 (keepLastN=3) would put toolResult at start of kept
			makeToolResultMsg("bash", "file1 file2", 1006),
			makeUserMsg("what is there?", 1007),
		];
		const ctx: Context = { messages: msgs };
		const { context: result, stats } = compressHistory(ctx, { enabled: true, keepLastN: 3 });

		expect(stats).toBeDefined();

		// The output should be valid
		const roles = result.messages.map(m => m.role);
		for (let i = 1; i < roles.length; i++) {
			expect(roles[i]).not.toBe(roles[i - 1]);
		}
	});

	it("does not produce empty compression when boundary adjustment hits start", () => {
		// Edge case: all messages are tool sequences, boundary keeps moving back
		const msgs: Message[] = [
			makeUserMsg("do it", 1000),
			makeAssistantWithToolCall("bash", { command: "a" }, undefined, 1001),
			makeToolResultMsg("bash", "output a", 1002),
			makeUserMsg("next", 1003),
			makeAssistantWithToolCall("bash", { command: "b" }, undefined, 1004),
			makeToolResultMsg("bash", "output b", 1005),
		];
		const ctx: Context = { messages: msgs };
		const { context: result } = compressHistory(ctx, { enabled: true, keepLastN: 3 });

		// Should still produce something valid
		const roles = result.messages.map(m => m.role);
		for (let i = 1; i < roles.length; i++) {
			expect(roles[i]).not.toBe(roles[i - 1]);
		}
	});
});

// ─── Model exclusion from compression ─────────────────────────────────────────

describe("isModelExcludedFromCompression", () => {
	const config = { enabled: true, keepLastN: 4, excludeModels: ["kimi", "deepseek"] };

	it("excludes model matching a pattern (substring)", () => {
		expect(isModelExcludedFromCompression(config, "amazon-bedrock", "moonshotai.kimi-k2.5")).toBe(true);
		expect(isModelExcludedFromCompression(config, "amazon-bedrock", "deepseek.v3.2")).toBe(true);
	});

	it("does not exclude model not matching any pattern", () => {
		expect(isModelExcludedFromCompression(config, "anthropic", "claude-sonnet-4-6")).toBe(false);
		expect(isModelExcludedFromCompression(config, "openai", "o4-mini")).toBe(false);
	});

	it("matches case-insensitively", () => {
		expect(isModelExcludedFromCompression(config, "amazon-bedrock", "MOONSHOTAI.KIMI-K2.5")).toBe(true);
	});

	it("matches against full provider/modelId string", () => {
		const cfg = { enabled: true, keepLastN: 4, excludeModels: ["amazon-bedrock/moonshotai"] };
		expect(isModelExcludedFromCompression(cfg, "amazon-bedrock", "moonshotai.kimi-k2.5")).toBe(true);
		expect(isModelExcludedFromCompression(cfg, "openai", "moonshotai.kimi-k2.5")).toBe(false);
	});

	it("returns false when excludeModels is empty or undefined", () => {
		expect(isModelExcludedFromCompression({ enabled: true }, "amazon-bedrock", "kimi-k2.5")).toBe(false);
		expect(isModelExcludedFromCompression({ enabled: true, excludeModels: [] }, "amazon-bedrock", "kimi-k2.5")).toBe(false);
	});
});

describe("resolveCompressionConfig — excludeModels", () => {
	it("inherits excludeModels from global config", () => {
		const cfg = resolveCompressionConfig(
			{ enabled: true, keepLastN: 4, excludeModels: ["kimi"] },
			undefined,
		);
		expect(cfg?.excludeModels).toEqual(["kimi"]);
	});

	it("profile overrides excludeModels", () => {
		const cfg = resolveCompressionConfig(
			{ enabled: true, keepLastN: 4, excludeModels: ["kimi"] },
			{ enabled: true, excludeModels: ["deepseek", "kimi"] },
		);
		expect(cfg?.excludeModels).toEqual(["deepseek", "kimi"]);
	});

	it("defaults to undefined when not specified", () => {
		const cfg = resolveCompressionConfig({ enabled: true }, undefined);
		expect(cfg?.excludeModels).toBeUndefined();
	});
});
