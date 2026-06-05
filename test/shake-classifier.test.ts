/**
 * Tests for shakeForClassifier — the shake-style elision applied to classifier inputs.
 *
 * Covers:
 * - Fenced code blocks (``` and ~~~) replaced by token annotation
 * - XML blocks replaced by token annotation
 * - Small blocks below SHAKE_MIN_SAVINGS left intact
 * - Surrounding prose preserved
 * - Hard budget cap applied after shake
 * - Integration: large user messages don't blow through MAX_PROMPT_CHARS
 * - Integration: history entries are shaken inside buildClassifierPrompt
 */
import { describe, test, expect } from "bun:test";
import { shakeForClassifier, buildClassifierPrompt } from "../src/calibration/classifier-utils";
import type { Context } from "@oh-my-pi/pi-ai";

// ─── shakeForClassifier unit tests ────────────────────────────────────────────

describe("shakeForClassifier — fenced code blocks", () => {
	test("replaces a large backtick fence with annotation", () => {
		const code = "x".repeat(200);
		const text = `Here is the code:\n\`\`\`ts\n${code}\n\`\`\`\nDo something.`;
		const result = shakeForClassifier(text, 10_000);
		expect(result).not.toContain(code);
		expect(result).toContain("[code block ~");
		expect(result).toContain("tokens elided]");
		// prose is preserved
		expect(result).toContain("Here is the code:");
		expect(result).toContain("Do something.");
	});

	test("replaces a large tilde fence with annotation", () => {
		const code = "y".repeat(200);
		const text = `Intro.\n~~~python\n${code}\n~~~\nOutro.`;
		const result = shakeForClassifier(text, 10_000);
		expect(result).not.toContain(code);
		expect(result).toContain("[code block ~");
	});

	test("leaves a small fence intact (below SHAKE_MIN_SAVINGS = 80 chars)", () => {
		const text = "Fix this:\n```\nconst x = 1;\n```\nDone.";
		const result = shakeForClassifier(text, 10_000);
		expect(result).toContain("const x = 1;");
		expect(result).not.toContain("elided");
	});

	test("handles multiple fences — each independently evaluated", () => {
		const big = "z".repeat(200);
		const text = `\`\`\`ts\n${big}\n\`\`\`\nand\n\`\`\`ts\n${big}\n\`\`\``;
		const result = shakeForClassifier(text, 10_000);
		expect((result.match(/\[code block/g) ?? []).length).toBe(2);
	});
});

describe("shakeForClassifier — XML blocks", () => {
	test("replaces a large XML block with annotation", () => {
		const inner = "content ".repeat(40); // ~320 chars
		const text = `Please read:\n<file>\n${inner}\n</file>\nThen edit.`;
		const result = shakeForClassifier(text, 10_000);
		expect(result).not.toContain(inner);
		expect(result).toContain("[xml block ~");
		expect(result).toContain("tokens elided]");
		expect(result).toContain("Please read:");
		expect(result).toContain("Then edit.");
	});

	test("leaves a small XML block intact", () => {
		const text = "See <b>this</b> note.";
		const result = shakeForClassifier(text, 10_000);
		expect(result).toContain("<b>this</b>");
		expect(result).not.toContain("elided");
	});

	test("handles XML with attributes", () => {
		const inner = "a".repeat(200);
		const text = `<tool_result id="123">${inner}</tool_result>`;
		const result = shakeForClassifier(text, 10_000);
		expect(result).toContain("[xml block ~");
		expect(result).not.toContain(inner);
	});
});

describe("shakeForClassifier — budget cap", () => {
	test("applies budget even when no blocks are elided", () => {
		const text = "a".repeat(500);
		const result = shakeForClassifier(text, 100);
		expect(result.length).toBe(100);
	});

	test("budget applied after shake — elided text frees budget for prose", () => {
		const big = "x".repeat(400);
		// prose (30 chars) + code fence (>400 chars) + prose (30 chars)
		const prose1 = "Start of message here. ";
		const prose2 = " End of message here.";
		const text = `${prose1}\`\`\`ts\n${big}\n\`\`\`${prose2}`;
		const result = shakeForClassifier(text, 200);
		// After shake the fence becomes ~40 chars, total is well under 200
		expect(result).toContain(prose1.trim());
		expect(result).not.toContain(big);
	});
});

describe("shakeForClassifier — prose preservation", () => {
	test("plain prose with no blocks passes through unchanged (within budget)", () => {
		const text = "refactor the auth module to use JWT instead of sessions";
		const result = shakeForClassifier(text, 10_000);
		expect(result).toBe(text);
	});

	test("intent survives when message has both intent and a large paste", () => {
		const intent = "implement the feature described below:";
		const paste = "function ".repeat(100); // 900 chars
		const text = `${intent}\n\`\`\`ts\n${paste}\n\`\`\``;
		const result = shakeForClassifier(text, 10_000);
		expect(result).toContain(intent);
		expect(result).not.toContain(paste);
	});
});

// ─── Integration: buildClassifierPrompt ───────────────────────────────────────

describe("buildClassifierPrompt — shake integration", () => {
	test("large last user message is shaken before classifier sees it", () => {
		const bigCode = "const x = 1;\n".repeat(100); // ~1400 chars
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content: `Can you refactor this?\n\`\`\`ts\n${bigCode}\`\`\``,
				},
			],
		};
		const prompt = buildClassifierPrompt(ctx);
		expect(prompt).not.toContain(bigCode);
		expect(prompt).toContain("[code block ~");
		expect(prompt).toContain("Can you refactor this?");
	});

	test("large XML in user message is shaken", () => {
		const bigXml = "<result>" + "data ".repeat(100) + "</result>";
		const ctx: Context = {
			messages: [{ role: "user", content: `Process this:\n${bigXml}` }],
		};
		const prompt = buildClassifierPrompt(ctx);
		expect(prompt).not.toContain("data ".repeat(10));
		expect(prompt).toContain("[xml block ~");
	});

	test("short plain user message is not modified", () => {
		const msg = "summarize the last three changes";
		const ctx: Context = { messages: [{ role: "user", content: msg }] };
		const prompt = buildClassifierPrompt(ctx);
		expect(prompt).toContain(msg);
		expect(prompt).not.toContain("elided");
	});

	test("history user messages are shaken too", () => {
		const bigCode = "let a = 1;\n".repeat(50); // ~550 chars
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content: `Earlier context:\n\`\`\`ts\n${bigCode}\`\`\``,
				},
				{ role: "assistant", content: "Done." },
				{ role: "user", content: "now do the next step" },
			],
		};
		const prompt = buildClassifierPrompt(ctx);
		// The big code from history should be elided
		expect(prompt).not.toContain(bigCode);
		// The final user message and assistant reply should survive
		expect(prompt).toContain("now do the next step");
	});

	test("tool result content never appears regardless of shake", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "go" },
				{
					role: "assistant",
					content: [{ type: "toolCall", name: "read", arguments: { path: "/secret" } }],
				},
				{ role: "toolResult", content: "TOP_SECRET_PAYLOAD" },
				{ role: "user", content: "use that" },
			],
		};
		const prompt = buildClassifierPrompt(ctx);
		expect(prompt).not.toContain("TOP_SECRET_PAYLOAD");
	});

	test("prompt stays within reasonable bounds for pathological input", () => {
		// 10 KB user message with a giant code fence
		const giant = "x".repeat(10_000);
		const ctx: Context = {
			messages: [
				{
					role: "user",
					content: `Fix:\n\`\`\`ts\n${giant}\n\`\`\``,
				},
			],
		};
		const prompt = buildClassifierPrompt(ctx);
		// Prompt should be well under 4000 chars (the static template is ~700 chars)
		expect(prompt.length).toBeLessThan(4000);
	});
});
