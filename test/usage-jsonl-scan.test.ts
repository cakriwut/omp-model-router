/**
 * Tests for scanSessionTree — JSONL file scanning for usage reporting.
 *
 * Verifies parent + child session aggregation, corrupt file handling,
 * role filtering, and router/auto exclusion.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSessionTree } from "../src/commands/usage";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAssistantLine(
	provider: string,
	model: string,
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number },
): string {
	return JSON.stringify({
		type: "message",
		message: {
			role: "assistant",
			provider,
			model,
			usage: {
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: usage.cost },
			},
		},
	});
}

function writeTmpSession(dir: string, name: string, lines: string[]): string {
	const path = join(dir, name);
	writeFileSync(path, lines.join("\n"));
	return path;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("scanSessionTree", () => {
	test("empty parent file — only session header", () => {
		const dir = mkdtempSync(join(tmpdir(), "scan-"));
		const sessionFile = writeTmpSession(dir, "session.jsonl", [
			JSON.stringify({ type: "session", sessionId: "abc123" }),
		]);

		const result = scanSessionTree(sessionFile);
		expect(result.size).toBe(0);
	});

	test("parent with 2 assistant messages, same model — aggregates", () => {
		const dir = mkdtempSync(join(tmpdir(), "scan-"));
		const sessionFile = writeTmpSession(dir, "session.jsonl", [
			makeAssistantLine("amazon-bedrock", "global.anthropic.claude-haiku", {
				input: 10, output: 100, cacheRead: 500, cacheWrite: 50, cost: 0.001,
			}),
			makeAssistantLine("amazon-bedrock", "global.anthropic.claude-haiku", {
				input: 20, output: 200, cacheRead: 600, cacheWrite: 60, cost: 0.002,
			}),
		]);

		const result = scanSessionTree(sessionFile);
		expect(result.size).toBe(1);

		const entry = result.get("amazon-bedrock/global.anthropic.claude-haiku")!;
		expect(entry).toBeDefined();
		expect(entry.invocations).toBe(2);
		expect(entry.inputTokens).toBe(30);
		expect(entry.outputTokens).toBe(300);
		expect(entry.cacheReadTokens).toBe(1100);
		expect(entry.cacheWriteTokens).toBe(110);
		expect(entry.cost).toBeCloseTo(0.003);
	});

	test("parent with 2 different models — separate entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "scan-"));
		const sessionFile = writeTmpSession(dir, "session.jsonl", [
			makeAssistantLine("amazon-bedrock", "global.anthropic.claude-haiku", {
				input: 10, output: 100, cacheRead: 500, cacheWrite: 50, cost: 0.001,
			}),
			makeAssistantLine("openai", "gpt-4o", {
				input: 5, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.005,
			}),
		]);

		const result = scanSessionTree(sessionFile);
		expect(result.size).toBe(2);

		const haiku = result.get("amazon-bedrock/global.anthropic.claude-haiku")!;
		expect(haiku.invocations).toBe(1);
		expect(haiku.inputTokens).toBe(10);
		expect(haiku.cost).toBeCloseTo(0.001);

		const gpt = result.get("openai/gpt-4o")!;
		expect(gpt.invocations).toBe(1);
		expect(gpt.inputTokens).toBe(5);
		expect(gpt.cost).toBeCloseTo(0.005);
	});

	test("router/auto entries skipped", () => {
		const dir = mkdtempSync(join(tmpdir(), "scan-"));
		const sessionFile = writeTmpSession(dir, "session.jsonl", [
			makeAssistantLine("router", "auto", {
				input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.001,
			}),
			makeAssistantLine("amazon-bedrock", "global.anthropic.claude-haiku", {
				input: 5, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.002,
			}),
		]);

		const result = scanSessionTree(sessionFile);
		expect(result.size).toBe(1);
		expect(result.has("router/auto")).toBe(false);
		expect(result.has("amazon-bedrock/global.anthropic.claude-haiku")).toBe(true);
	});

	test("child dir does not exist — no error, returns parent entries", () => {
		const dir = mkdtempSync(join(tmpdir(), "scan-"));
		const sessionFile = writeTmpSession(dir, "session.jsonl", [
			makeAssistantLine("amazon-bedrock", "global.anthropic.claude-haiku", {
				input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.001,
			}),
		]);

		// No sibling directory created — should not throw
		const result = scanSessionTree(sessionFile);
		expect(result.size).toBe(1);
		expect(result.get("amazon-bedrock/global.anthropic.claude-haiku")!.invocations).toBe(1);
	});

	test("child dir with 2 child JSONL files — accumulates across tree", () => {
		const dir = mkdtempSync(join(tmpdir(), "scan-"));
		const sessionFile = writeTmpSession(dir, "parent.jsonl", [
			makeAssistantLine("amazon-bedrock", "global.anthropic.claude-haiku", {
				input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.001,
			}),
		]);

		// Child dir: same path as parent minus .jsonl
		const childDir = join(dir, "parent");
		mkdirSync(childDir);

		// Child 1: same model as parent
		writeTmpSession(childDir, "child1.jsonl", [
			makeAssistantLine("amazon-bedrock", "global.anthropic.claude-haiku", {
				input: 20, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.002,
			}),
		]);

		// Child 2: new model
		writeTmpSession(childDir, "child2.jsonl", [
			makeAssistantLine("openai", "gpt-4o", {
				input: 5, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.005,
			}),
		]);

		const result = scanSessionTree(sessionFile);
		expect(result.size).toBe(2);

		const haiku = result.get("amazon-bedrock/global.anthropic.claude-haiku")!;
		expect(haiku.invocations).toBe(2);
		expect(haiku.inputTokens).toBe(30);
		expect(haiku.cost).toBeCloseTo(0.003);

		const gpt = result.get("openai/gpt-4o")!;
		expect(gpt.invocations).toBe(1);
		expect(gpt.inputTokens).toBe(5);
		expect(gpt.cost).toBeCloseTo(0.005);
	});

	test("corrupt child file — does not throw, returns parent totals", () => {
		const dir = mkdtempSync(join(tmpdir(), "scan-"));
		const sessionFile = writeTmpSession(dir, "parent.jsonl", [
			makeAssistantLine("amazon-bedrock", "global.anthropic.claude-haiku", {
				input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.001,
			}),
		]);

		const childDir = join(dir, "parent");
		mkdirSync(childDir);
		writeTmpSession(childDir, "corrupt.jsonl", [
			"this is not valid json {{{{",
			"also broken }}}",
		]);

		const result = scanSessionTree(sessionFile);
		expect(result.size).toBe(1);
		expect(result.get("amazon-bedrock/global.anthropic.claude-haiku")!.invocations).toBe(1);
	});

	test("non-assistant lines ignored", () => {
		const dir = mkdtempSync(join(tmpdir(), "scan-"));
		const sessionFile = writeTmpSession(dir, "session.jsonl", [
			JSON.stringify({ type: "session", sessionId: "abc" }),
			JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
			JSON.stringify({ type: "message", message: { role: "toolResult", content: "done" } }),
			makeAssistantLine("amazon-bedrock", "global.anthropic.claude-haiku", {
				input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.001,
			}),
		]);

		const result = scanSessionTree(sessionFile);
		expect(result.size).toBe(1);
		expect(result.get("amazon-bedrock/global.anthropic.claude-haiku")!.invocations).toBe(1);
	});

	test("tool result line with usage field ignored", () => {
		const dir = mkdtempSync(join(tmpdir(), "scan-"));
		const sessionFile = writeTmpSession(dir, "session.jsonl", [
			JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					content: "result",
					usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 300, cost: { total: 0.5 } },
				},
			}),
			makeAssistantLine("amazon-bedrock", "global.anthropic.claude-haiku", {
				input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0.001,
			}),
		]);

		const result = scanSessionTree(sessionFile);
		expect(result.size).toBe(1);
		// The toolResult line should not appear as an entry
		expect(result.has("toolResult")).toBe(false);
		expect(result.get("amazon-bedrock/global.anthropic.claude-haiku")!.invocations).toBe(1);
	});
});
