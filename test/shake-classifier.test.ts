/**
 * Tests for shakeForClassifier (history elision) and stripForUserMessage (user intent extraction).
 *
 * Covers:
 * - shakeForClassifier: fenced code blocks and XML blocks replaced by token annotation
 * - stripForUserMessage: XML wrapper tags stripped (inner content kept), code blocks elided
 * - Small blocks below SHAKE_MIN_SAVINGS left intact in both functions
 * - Hard budget cap applied after processing
 * - Integration: buildClassifierPrompt uses stripForUserMessage for the last user message
 *   and shakeForClassifier for history assistant messages
 */
import { describe, test, expect } from "bun:test";
import { shakeForClassifier, stripForUserMessage, extractUserBareText, buildClassifierPrompt } from "../src/calibration/classifier-utils";
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
		// truncateAtWord appends "…" when cut, total ≤ budget + 1 (the ellipsis)
		expect(result.length).toBeLessThanOrEqual(101);
		expect(result.startsWith("a")).toBe(true);
	});

	test("budget applied after shake — elided text frees budget for prose", () => {
		const big = "x".repeat(400);
		const prose1 = "Start of message here. ";
		const prose2 = " End of message here.";
		const text = `${prose1}\`\`\`ts\n${big}\n\`\`\`${prose2}`;
		const result = shakeForClassifier(text, 200);
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

describe("buildClassifierPrompt — user message extraction", () => {
	test("last user message: code fence is elided (paste noise)", () => {
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
		expect(prompt).toContain("[code ~");
		expect(prompt).toContain("Can you refactor this?");
	});

	test("last user message: XML wrapper is stripped, inner text survives", () => {
		const inner = "implement the new feature I described earlier";
		const ctx: Context = {
			messages: [{ role: "user", content: `<system-directive>${inner}</system-directive>` }],
		};
		const prompt = buildClassifierPrompt(ctx);
		// Inner content must reach the classifier
		expect(prompt).toContain(inner);
		// Elision placeholder must NOT appear
		expect(prompt).not.toContain("[xml block ~");
		expect(prompt).not.toContain("elided");
	});

	test("last user message: harness context blocks stripped, real user text kept", () => {
		const userIntent = "from the prompt log it is very clear we have an issue";
		const ctx: Context = {
			messages: [{
				role: "user",
				content: `<context>\nsome injected file content\n</context>\n${userIntent}`,
			}],
		};
		const prompt = buildClassifierPrompt(ctx);
		expect(prompt).toContain(userIntent);
		expect(prompt).not.toContain("[xml block ~");
	});

	test("last user message: multiple nested XML wrappers are all stripped", () => {
		const intent = "debug the routing decision";
		const ctx: Context = {
			messages: [{
				role: "user",
				content: `<workspace-tree>\n...\n</workspace-tree>\n<context>\n...\n</context>\n${intent}`,
			}],
		};
		const prompt = buildClassifierPrompt(ctx);
		expect(prompt).toContain(intent);
		expect(prompt).not.toContain("elided");
	});

	test("short plain user message passes through unchanged", () => {
		const msg = "summarize the last three changes";
		const ctx: Context = { messages: [{ role: "user", content: msg }] };
		const prompt = buildClassifierPrompt(ctx);
		expect(prompt).toContain(msg);
		expect(prompt).not.toContain("elided");
	});

	test("history user messages: bare user text (outside XML blocks) appears in prompt", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "<context>big file listing here</context>\nEarlier I asked about routing" },
				{ role: "assistant", content: "Done." },
				{ role: "user", content: "now do the next step" },
			],
		};
		const prompt = buildClassifierPrompt(ctx);
		// Earlier history user text (not the current turn) must appear in Conversation:
		expect(prompt).toContain("Earlier I asked about routing");
		// Current user turn is in "User:" — must NOT be duplicated in Conversation:
		// Current user turn is in <request> — must NOT be duplicated in <history>
		const historySection = prompt.split("<request>")[0];
		expect(historySection).not.toContain("now do the next step");
		// Injected XML inner content never appears
		expect(prompt).not.toContain("big file listing here");
	});

	test("history user messages: pure harness-injection turns are skipped entirely", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "<workspace-tree>\nsome tree\n</workspace-tree>" },
				{ role: "assistant", content: "Working on it, the fix is straightforward." },
				{ role: "user", content: "implement the auth fix" },
			],
		};
		const prompt = buildClassifierPrompt(ctx);
		expect(prompt).toContain("<request>\nimplement the auth fix\n</request>");
		expect(prompt).not.toContain("some tree");
		expect(prompt).toContain("B: Working on it, the fix is straightforward.");
	});

	test("tool result content never appears", () => {
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
		const giant = "x".repeat(10_000);
		const ctx: Context = {
			messages: [{ role: "user", content: `Fix:\n\`\`\`ts\n${giant}\n\`\`\`` }],
		};
		const prompt = buildClassifierPrompt(ctx);
		expect(prompt.length).toBeLessThan(4000);
	});
});

// ─── stripForUserMessage unit tests ───────────────────────────────────────────

describe("stripForUserMessage — XML wrapper stripping", () => {
	test("strips top-level XML tags, keeps inner text", () => {
		const inner = "implement the feature I described";
		const result = stripForUserMessage(`<system-directive>${inner}</system-directive>`, 10_000);
		expect(result).toContain(inner);
		expect(result).not.toContain("<system-directive>");
		expect(result).not.toContain("elided");
	});

	test("strips multiple XML blocks", () => {
		const result = stripForUserMessage(
			"<context>ctx content</context>\n<file path='x'>file body</file>\ndo the thing",
			10_000,
		);
		expect(result).toContain("ctx content");
		expect(result).toContain("file body");
		expect(result).toContain("do the thing");
		expect(result).not.toContain("<context>");
	});

	test("elides fenced code blocks (paste noise)", () => {
		const code = "const x = 1;\n".repeat(20);
		const result = stripForUserMessage(`fix this:\n\`\`\`ts\n${code}\`\`\``, 10_000);
		expect(result).not.toContain(code);
		expect(result).toContain("[code ~");
		expect(result).toContain("fix this:");
	});

	test("small XML block left intact (below SHAKE_MIN_SAVINGS)", () => {
		const result = stripForUserMessage("See <b>this</b> note.", 10_000);
		// Small tag kept — but stripped means we keep inner "this"
		expect(result).toContain("this");
	});
describe("stripForUserMessage — budget cap", () => {
	test("respects budget cap after stripping (truncateAtWord appends ellipsis)", () => {
		const longText = "word ".repeat(100); // 500 chars of words
		const result = stripForUserMessage(longText, 100);
		// Must be at or near the budget; ellipsis appended when cut at word boundary
		expect(result.length).toBeLessThanOrEqual(101);
	});
});

// ─── extractUserBareText unit tests ───────────────────────────────────────────

describe("extractUserBareText — remove XML, keep prose", () => {
	test("removes XML blocks entirely, keeps surrounding prose", () => {
		const result = extractUserBareText(
			"<workspace-tree>\nfile tree\n</workspace-tree>\nfix the bug",
			10_000,
		);
		expect(result).toBe("fix the bug");
		expect(result).not.toContain("file tree");
	});

	test("multiple XML blocks removed, bare text kept", () => {
		const result = extractUserBareText(
			"<context>ctx</context>\n<file>body</file>\ndo the thing",
			10_000,
		);
		expect(result).toBe("do the thing");
		expect(result).not.toContain("ctx");
		expect(result).not.toContain("body");
	});

	test("pure XML injection with no bare text returns empty string", () => {
		const result = extractUserBareText(
			"<workspace-tree>\nsome tree\n</workspace-tree>",
			10_000,
		);
		expect(result).toBe("");
	});

	test("plain text with no XML passes through", () => {
		const text = "implement the auth module fix";
		expect(extractUserBareText(text, 10_000)).toBe(text);
	});

	test("respects budget cap", () => {
		const result = extractUserBareText("word ".repeat(100), 50);
		expect(result.length).toBeLessThanOrEqual(51);
	});
});
});

// ─── detectSignals unit tests ─────────────────────────────────────────────────

import { detectSignals } from "../src/calibration/classifier-utils";

describe("detectSignals", () => {
	test("returns empty for single user message", () => {
		const ctx: Context = { messages: [{ role: "user", content: "fix the bug" }] };
		expect(detectSignals(ctx)).toEqual([]);
	});

	test("detects repeated_instruction when user repeats same request", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "check the classifier log" },
				{ role: "assistant", content: "Here are the results." },
				{ role: "user", content: "check the classifier log again" },
			],
		};
		expect(detectSignals(ctx)).toContain("repeated_instruction");
	});

	test("does not flag as repeated when messages are unrelated", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "deploy to production" },
				{ role: "assistant", content: "Done." },
				{ role: "user", content: "write unit tests for auth module" },
			],
		};
		expect(detectSignals(ctx)).not.toContain("repeated_instruction");
	});

	test("detects escalation_request", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "fix the routing bug" },
				{ role: "assistant", content: "Fixed." },
				{ role: "user", content: "that is not right, try again" },
			],
		};
		expect(detectSignals(ctx)).toContain("escalation_request");
	});

	test("detects refine_previous", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "write the summary" },
				{ role: "assistant", content: "Here it is." },
				{ role: "user", content: "improve the summary" },
			],
		};
		expect(detectSignals(ctx)).toContain("refine_previous");
	});

	test("signals appear in classifier prompt", () => {
		const ctx: Context = {
			messages: [
				{ role: "user", content: "fix the routing bug" },
				{ role: "assistant", content: "Fixed it here." },
				{ role: "user", content: "that is not right, try again" },
			],
		};
		const prompt = buildClassifierPrompt(ctx, undefined, {}, undefined, 128_000);
		expect(prompt).toContain("<signals>");
		expect(prompt).toContain("escalate");
	});

	test("no Signals line when no signals detected", () => {
		const ctx: Context = { messages: [{ role: "user", content: "summarize the changes" }] };
		const prompt = buildClassifierPrompt(ctx, undefined, {}, undefined, 128_000);
		expect(prompt).not.toContain("<signals>");
	});
});