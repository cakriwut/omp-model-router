/**
 * Unit tests for context sanitization — tool name validation.
 *
 * Bug: Bedrock HTTP 400 when conversation history contains malformed tool names
 * from previous model responses (e.g., leaked special tokens like
 * `<|tool_call_argument_begin|>` in the name field).
 *
 * Error: "Value at 'messages.54.member.content.2.member.toolUse.name' failed to
 * satisfy constraint: Member must satisfy regular expression pattern: [a-zA-Z0-9_-]+"
 *
 * Fix: sanitizeContext() scans context messages and replaces invalid tool names
 * before sending to the provider API.
 *
 * Reference: /home/riwut/.omp/logs/http-400-requests/1779849244165-3bwr2pjkrd8jh.json
 */

import { describe, it, expect } from "bun:test";
import { sanitizeToolName, sanitizeContext, VALID_TOOL_NAME_RE } from "./provider";
import type { Context } from "@oh-my-pi/pi-ai";

// ─── Sample Fixtures ─────────────────────────────────────────────────────────

/** Valid context — no sanitization needed */
const VALID_CONTEXT: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [
		{
			role: "user",
			content: [{ type: "text", text: "Read the config file" }],
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "I'll read the config file for you." },
				{
					type: "toolCall",
					id: "call_abc123",
					name: "read",
					arguments: { path: "/home/user/.config/app.json" },
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "toolResult",
					toolCallId: "call_abc123",
					content: [{ type: "text", text: '{"key": "value"}' }],
				},
			],
		},
	],
};

/** Malformed context — leaked special tokens in tool name (real-world bug) */
const MALFORMED_CONTEXT_LEAKED_TOKENS: Context = {
	systemPrompt: ["You are a helpful assistant."],
	messages: [
		{
			role: "user",
			content: [{ type: "text", text: "Read the config" }],
		},
		{
			role: "assistant",
			content: [
				{ type: "text", text: "The command failed. Better approach - just check the actual config file directly:" },
				{
					type: "toolCall",
					id: "functions_read_1___tool_call_argument_begin_____path_____home_ri",
					name: 'functions_read_1 <|tool_call_argument_begin|> {"path"',
					arguments: {},
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "toolResult",
					toolCallId: "functions_read_1___tool_call_argument_begin_____path_____home_ri",
					content: [{ type: "text", text: "Tool error: invalid invocation" }],
				},
			],
		},
	],
};

/** Malformed context — tool name with dots, slashes, and spaces */
const MALFORMED_CONTEXT_SPECIAL_CHARS: Context = {
	systemPrompt: ["System prompt"],
	messages: [
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_001",
					name: "my.tool/name with spaces",
					arguments: { arg: "value" },
				},
			],
		},
	],
};

/** Malformed context — tool name is entirely invalid characters */
const MALFORMED_CONTEXT_ALL_INVALID: Context = {
	systemPrompt: undefined,
	messages: [
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_002",
					name: "<<<>>>!!!@@@",
					arguments: { x: 1 },
				},
			],
		},
	],
};

/** Context with multiple tool calls — mix of valid and invalid */
const MIXED_CONTEXT: Context = {
	systemPrompt: ["mixed test"],
	messages: [
		{
			role: "assistant",
			content: [
				{ type: "text", text: "I'll run two tools." },
				{
					type: "toolCall",
					id: "call_valid",
					name: "bash_execute",
					arguments: { command: "ls" },
				},
				{
					type: "toolCall",
					id: "call_invalid",
					name: "bash execute (run command)",
					arguments: { command: "pwd" },
				},
			],
		},
		{
			role: "user",
			content: [
				{
					type: "toolResult",
					toolCallId: "call_valid",
					content: [{ type: "text", text: "file1.ts\nfile2.ts" }],
				},
				{
					type: "toolResult",
					toolCallId: "call_invalid",
					content: [{ type: "text", text: "/home/user" }],
				},
			],
		},
	],
};

/** Edge case — very long tool name that needs truncation */
const LONG_NAME_CONTEXT: Context = {
	systemPrompt: undefined,
	messages: [
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: "call_long",
					name: "a".repeat(100) + " invalid chars " + "b".repeat(100),
					arguments: {},
				},
			],
		},
	],
};

// ─── Tests: sanitizeToolName ─────────────────────────────────────────────────

describe("sanitizeToolName", () => {
	it("returns valid names unchanged", () => {
		expect(sanitizeToolName("read")).toBe("read");
		expect(sanitizeToolName("bash_execute")).toBe("bash_execute");
		expect(sanitizeToolName("my-tool-123")).toBe("my-tool-123");
		expect(sanitizeToolName("Tool_Name_V2")).toBe("Tool_Name_V2");
	});

	it("replaces spaces with underscores", () => {
		expect(sanitizeToolName("my tool")).toBe("my_tool");
	});

	it("replaces special tokens and angle brackets", () => {
		const input = 'functions_read_1 <|tool_call_argument_begin|> {"path"';
		const result = sanitizeToolName(input);
		expect(VALID_TOOL_NAME_RE.test(result)).toBe(true);
		expect(result).toBe("functions_read_1___tool_call_argument_begin_____path_");
	});

	it("replaces dots, slashes, and other punctuation", () => {
		const result = sanitizeToolName("my.tool/name@v2");
		expect(result).toBe("my_tool_name_v2");
		expect(VALID_TOOL_NAME_RE.test(result)).toBe(true);
	});

	it("returns 'unknown_tool' for entirely invalid names", () => {
		expect(sanitizeToolName("<<<>>>")).toBe("______");
		// Empty after replace shouldn't happen with the above, but test the fallback
		expect(sanitizeToolName("")).toBe("unknown_tool");
	});

	it("truncates to 64 characters", () => {
		const longName = "a".repeat(100) + " invalid " + "b".repeat(100);
		const result = sanitizeToolName(longName);
		expect(result.length).toBeLessThanOrEqual(64);
		expect(VALID_TOOL_NAME_RE.test(result)).toBe(true);
	});

	it("preserves hyphens and underscores", () => {
		expect(sanitizeToolName("my_tool-name")).toBe("my_tool-name");
	});
});

// ─── Tests: sanitizeContext ──────────────────────────────────────────────────

describe("sanitizeContext", () => {
	it("returns same reference for already-valid context (no allocation)", () => {
		const result = sanitizeContext(VALID_CONTEXT);
		expect(result).toBe(VALID_CONTEXT); // same object reference
	});

	it("sanitizes leaked special tokens in tool names (real-world bug)", () => {
		const result = sanitizeContext(MALFORMED_CONTEXT_LEAKED_TOKENS);

		// Should NOT be the same reference (was modified)
		expect(result).not.toBe(MALFORMED_CONTEXT_LEAKED_TOKENS);

		// The tool call name should now be valid
		const assistantMsg = result.messages[1];
		const toolCall = assistantMsg.content[1] as any;
		expect(toolCall.type).toBe("toolCall");
		expect(VALID_TOOL_NAME_RE.test(toolCall.name)).toBe(true);
		expect(toolCall.name).toBe("functions_read_1___tool_call_argument_begin_____path_");

		// Other fields preserved
		expect(toolCall.id).toBe("functions_read_1___tool_call_argument_begin_____path_____home_ri");
		expect(toolCall.arguments).toEqual({});

		// Text block unchanged
		const textBlock = assistantMsg.content[0] as any;
		expect(textBlock.type).toBe("text");
		expect(textBlock.text).toBe("The command failed. Better approach - just check the actual config file directly:");

		// System prompt preserved
		expect(result.systemPrompt).toEqual(["You are a helpful assistant."]);
	});

	it("sanitizes tool names with dots, slashes, and spaces", () => {
		const result = sanitizeContext(MALFORMED_CONTEXT_SPECIAL_CHARS);
		const toolCall = result.messages[0].content[0] as any;
		expect(toolCall.name).toBe("my_tool_name_with_spaces");
		expect(VALID_TOOL_NAME_RE.test(toolCall.name)).toBe(true);
	});

	it("handles entirely invalid tool names", () => {
		const result = sanitizeContext(MALFORMED_CONTEXT_ALL_INVALID);
		const toolCall = result.messages[0].content[0] as any;
		expect(VALID_TOOL_NAME_RE.test(toolCall.name)).toBe(true);
		// All chars replaced with underscores
		expect(toolCall.name).toBe("____________");
	});

	it("sanitizes only invalid names in mixed context", () => {
		const result = sanitizeContext(MIXED_CONTEXT);

		const content = result.messages[0].content;
		// Text block unchanged
		expect((content[0] as any).text).toBe("I'll run two tools.");
		// Valid tool call unchanged
		expect((content[1] as any).name).toBe("bash_execute");
		// Invalid tool call sanitized
		expect((content[2] as any).name).toBe("bash_execute__run_command_");
		expect(VALID_TOOL_NAME_RE.test((content[2] as any).name)).toBe(true);
	});

	it("truncates long sanitized tool names to 64 chars", () => {
		const result = sanitizeContext(LONG_NAME_CONTEXT);
		const toolCall = result.messages[0].content[0] as any;
		expect(toolCall.name.length).toBeLessThanOrEqual(64);
		expect(VALID_TOOL_NAME_RE.test(toolCall.name)).toBe(true);
	});

	it("preserves tool result messages (does not modify user content)", () => {
		const result = sanitizeContext(MALFORMED_CONTEXT_LEAKED_TOKENS);
		const toolResult = result.messages[2].content[0] as any;
		expect(toolResult.type).toBe("toolResult");
		expect(toolResult.toolCallId).toBe("functions_read_1___tool_call_argument_begin_____path_____home_ri");
	});

	it("preserves systemPrompt when undefined", () => {
		const result = sanitizeContext(MALFORMED_CONTEXT_ALL_INVALID);
		expect(result.systemPrompt).toBeUndefined();
	});

	it("handles empty messages array", () => {
		const emptyCtx: Context = { systemPrompt: undefined, messages: [] };
		const result = sanitizeContext(emptyCtx);
		expect(result).toBe(emptyCtx); // no modification needed
	});

	it("handles messages with no content array gracefully", () => {
		const ctx: Context = {
			systemPrompt: undefined,
			messages: [{ role: "user", content: "plain string" } as any],
		};
		// Should not throw
		const result = sanitizeContext(ctx);
		expect(result.messages[0]).toEqual({ role: "user", content: "plain string" });
	});
});

// ─── Tests: VALID_TOOL_NAME_RE pattern ───────────────────────────────────────

describe("VALID_TOOL_NAME_RE", () => {
	const validNames = [
		"read",
		"bash_execute",
		"my-tool",
		"Tool123",
		"a",
		"A_B-C_D",
		"__private",
		"context-mode_ctx_search",
	];

	const invalidNames = [
		"my tool",
		"tool.name",
		"tool/name",
		"tool@v2",
		'functions_read_1 <|tool_call_argument_begin|> {"path"',
		"",
		"tool(arg)",
		"tool[0]",
		"tool{name}",
		"tool<name>",
	];

	for (const name of validNames) {
		it(`accepts valid name: "${name}"`, () => {
			expect(VALID_TOOL_NAME_RE.test(name)).toBe(true);
		});
	}

	for (const name of invalidNames) {
		it(`rejects invalid name: "${name.slice(0, 40)}"`, () => {
			expect(VALID_TOOL_NAME_RE.test(name)).toBe(false);
		});
	}
});
