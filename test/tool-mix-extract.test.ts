/**
 * Unit tests for Tool-Mix Extractor (Phase 2: classifier-tool-mix-signal)
 *
 * Tests cover extractRecentToolCalls semantics per the spec.
 */
import { describe, test, expect } from "bun:test";
import { extractRecentToolCalls } from "../src/utils/messages";
import type { Context } from "@oh-my-pi/pi-ai";

function makeCtx(msgs: Array<{ role: string; content: any }>): Context {
	return { messages: msgs as any };
}

function toolCall(name: string) {
	return { type: "toolCall", name, arguments: { SECRET_ARG: "should-not-appear" } };
}

describe("extractRecentToolCalls", () => {
	test("empty context returns empty result", () => {
		const { counts, names } = extractRecentToolCalls({ messages: [] });
		expect(counts).toEqual({});
		expect(names).toEqual([]);
	});

	test("only user messages returns empty result", () => {
		const ctx = makeCtx([
			{ role: "user", content: "hello" },
		]);
		const { counts, names } = extractRecentToolCalls(ctx);
		expect(counts).toEqual({});
		expect(names).toEqual([]);
	});

	test("assistant with text-only returns empty result", () => {
		const ctx = makeCtx([
			{ role: "user", content: "go" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
		]);
		const { counts, names } = extractRecentToolCalls(ctx);
		expect(counts).toEqual({});
		expect(names).toEqual([]);
	});

	test("single toolCall after user message", () => {
		const ctx = makeCtx([
			{ role: "user", content: "do it" },
			{ role: "assistant", content: [toolCall("read")] },
		]);
		const { counts, names } = extractRecentToolCalls(ctx);
		expect(counts).toEqual({ read: 1 });
		expect(names).toEqual(["read"]);
	});

	test("multiple toolCalls aggregated correctly", () => {
		const ctx = makeCtx([
			{ role: "user", content: "go" },
			{ role: "assistant", content: [toolCall("read"), toolCall("read"), toolCall("search")] },
			{ role: "assistant", content: [toolCall("edit")] },
		]);
		const { counts, names } = extractRecentToolCalls(ctx);
		expect(counts).toEqual({ read: 2, search: 1, edit: 1 });
		expect(names).toHaveLength(4);
	});

	test("stops at last user message — earlier tool calls excluded", () => {
		const ctx = makeCtx([
			{ role: "user", content: "first" },
			{ role: "assistant", content: [toolCall("write")] }, // before second user msg
			{ role: "user", content: "second" },
			{ role: "assistant", content: [toolCall("read"), toolCall("find")] },
		]);
		const { counts, names } = extractRecentToolCalls(ctx);
		// Only calls after "second" user message
		expect(counts).toEqual({ read: 1, find: 1 });
		expect(names).toEqual(["read", "find"]);
	});

	test("15 toolCalls — capped at 12 most recent", () => {
		// Create 15 tool calls: 3 writes first, then 12 reads
		const assistantContent = [
			toolCall("write"), toolCall("write"), toolCall("write"),  // oldest 3
			...Array(12).fill(null).map(() => toolCall("read")),      // newest 12
		];
		const ctx = makeCtx([
			{ role: "user", content: "go" },
			{ role: "assistant", content: assistantContent },
		]);
		const { counts, names } = extractRecentToolCalls(ctx);
		expect(names).toHaveLength(12);
		// The 3 oldest "write" calls are dropped; only reads remain
		expect(counts).toEqual({ read: 12 });
	});

	test("block with missing name is skipped (no crash)", () => {
		const ctx = makeCtx([
			{ role: "user", content: "go" },
			{ role: "assistant", content: [
				{ type: "toolCall", name: undefined },  // missing name
				{ type: "toolCall", name: "" },          // empty name
				toolCall("read"),                        // valid
			]},
		]);
		const { counts, names } = extractRecentToolCalls(ctx);
		expect(counts).toEqual({ read: 1 });
		expect(names).toEqual(["read"]);
	});

	test("never exposes tool arguments in result", () => {
		const ctx = makeCtx([
			{ role: "user", content: "go" },
			{ role: "assistant", content: [toolCall("read")] },
		]);
		const { counts, names } = extractRecentToolCalls(ctx);
		// Result should only contain tool names and counts — no argument values
		const resultStr = JSON.stringify({ counts, names });
		expect(resultStr).not.toContain("SECRET_ARG");
		expect(resultStr).not.toContain("should-not-appear");
	});

	test("toolResult messages are never read", () => {
		const ctx = makeCtx([
			{ role: "user", content: "go" },
			{ role: "toolResult", content: "SECRET_PAYLOAD_XYZ" },
			{ role: "assistant", content: [toolCall("read")] },
		]);
		const { counts } = extractRecentToolCalls(ctx);
		const resultStr = JSON.stringify(counts);
		expect(resultStr).not.toContain("SECRET_PAYLOAD_XYZ");
	});
});
