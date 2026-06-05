/**
 * Unit tests for classifier prompt tool-count injection (Phase 2: classifier-tool-mix-signal)
 *
 * Tests cover:
 * - Activity line appears with correct format when toolCounts provided
 * - Activity line omitted when toolCounts is undefined or empty
 * - Sorted by count descending
 * - Privacy: tool result content never leaks into prompt
 */
import { describe, test, expect } from "bun:test";
import { buildClassifierPrompt } from "../src/calibration/classifier-utils";
import type { Context } from "@oh-my-pi/pi-ai";

function makeCtx(userText: string): Context {
	return { messages: [{ role: "user", content: userText }] };
}

describe("buildClassifierPrompt — tool-count summary", () => {
	test("includes activity line when toolCounts provided and non-empty", () => {
		const ctx = makeCtx("implement the feature");
		const prompt = buildClassifierPrompt(ctx, "implementation", { read: 4, edit: 3, bash: 1 });
		expect(prompt).toContain(
			"<activity>read×4 edit×3 bash×1</activity>"
		);
	});

	test("activity line sorted by count descending", () => {
		const ctx = makeCtx("fix the bug");
		const prompt = buildClassifierPrompt(ctx, undefined, { bash: 2, read: 5, edit: 1 });
		expect(prompt).toContain("<activity>read×5 bash×2 edit×1</activity>");
	});

	test("omitted when toolCounts is undefined", () => {
		const ctx = makeCtx("summarize the file");
		const prompt = buildClassifierPrompt(ctx);
		expect(prompt).not.toContain("<activity>");
	});

	test("omitted when toolCounts is empty object", () => {
		const ctx = makeCtx("summarize the file");
		const prompt = buildClassifierPrompt(ctx, undefined, {});
		expect(prompt).not.toContain("<activity>");
	});

	test("prompt unchanged when no toolCounts (backward compat)", () => {
		const ctx = makeCtx("explain this");
		const withCounts = buildClassifierPrompt(ctx, undefined, {});
		const withoutCounts = buildClassifierPrompt(ctx);
		expect(withCounts).toBe(withoutCounts);
	});

	test("token bound: activity line for 3-5 tools is ≤200 chars (well under 20-token bound)", () => {
		const ctx = makeCtx("go");
		const prompt = buildClassifierPrompt(ctx, undefined, { read: 4, edit: 3, bash: 1 });
		// Find the activity line
		const lines = prompt.split("\n");
		const activityLine = lines.find((l) => l.startsWith("<activity>"));
		expect(activityLine).toBeDefined();
		expect(activityLine!.length).toBeLessThan(200);
	});
});

describe("buildClassifierPrompt — privacy invariant", () => {
	test("tool result content NEVER appears in classifier prompt", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "/etc/secret" } }],
				},
				{ role: "toolResult", content: "SECRET_PAYLOAD_XYZ" },
			],
		};
		const prompt = buildClassifierPrompt(ctx, undefined, { read: 1 });
		expect(prompt).not.toContain("SECRET_PAYLOAD_XYZ");
		expect(prompt).not.toContain("/etc/secret");
	});
});
