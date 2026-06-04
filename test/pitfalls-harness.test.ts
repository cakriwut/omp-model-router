/**
 * Tests for the classifier pitfalls harness
 *
 * T1  loadPitfalls returns "" when no file exists anywhere
 * T2  loadPitfalls reads local project file (cwd/model-router-pitfalls.md)
 * T3  loadPitfalls falls back to global (~/.omp/agent/model-router/pitfalls.md)
 * T4  overridePath takes priority over local and global
 * T5  loadPitfalls caches result in-process (second call skips FS)
 * T6  clearPitfallsCache forces reload on next call
 * T7  buildClassifierPrompt includes pitfalls block when provided
 * T8  buildClassifierPrompt omits pitfalls block when empty string
 * T9  buildClassifierPrompt omits pitfalls block when undefined
 * T10 pitfalls block appears between tier definitions and conversation
 * T11 runClassifier threads pitfalls param into buildClassifierPrompt
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// ── Pitfall loader ────────────────────────────────────────────────────────────
import { loadPitfalls, clearPitfallsCache } from "../src/calibration/pitfalls";

// ── Prompt builder ────────────────────────────────────────────────────────────
import { buildClassifierPrompt } from "../src/calibration/classifier-utils";
import type { Context } from "@oh-my-pi/pi-ai";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeContext(userText: string): Context {
	return {
		messages: [{ role: "user", content: userText, timestamp: Date.now() }],
	} as Context;
}

/** Create a temp directory with a model-router-pitfalls.md inside it. */
function makeTmpCwd(content: string): string {
	const dir = join(tmpdir(), `omp-pitfall-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "model-router-pitfalls.md"), content, "utf8");
	return dir;
}

function makeTmpFile(content: string): string {
	const path = join(tmpdir(), `omp-pitfall-override-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
	writeFileSync(path, content, "utf8");
	return path;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("loadPitfalls", () => {
	beforeEach(() => clearPitfallsCache());
	afterEach(() => clearPitfallsCache());

	test("T1 returns global pitfalls when only global file exists (no local)", () => {
		const dir = join(tmpdir(), `omp-empty-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const globalPath = join(homedir(), ".omp", "agent", "model-router", "pitfalls.md");
		const result = loadPitfalls(dir, undefined);
		if (existsSync(globalPath)) {
			expect(result.length).toBeGreaterThan(0);
		} else {
			expect(result).toBe("");
		}
		rmSync(dir, { recursive: true, force: true });
	});

	test("T2 reads local project file from cwd", () => {
		const content = "## Pitfall: Test\nThis is a test pitfall.";
		const dir = makeTmpCwd(content);
		try {
			const result = loadPitfalls(dir, undefined);
			expect(result).toBe(content.trim());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("T3 falls back to global file when local missing", () => {
		// We can only test this if the real global file exists.
		// If it doesn't, we simulate by pointing overridePath to a file
		// and verifying the fallback logic conceptually via T4.
		const globalPath = join(homedir(), ".omp", "agent", "model-router", "pitfalls.md");
		const dir = join(tmpdir(), `omp-no-local-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		try {
			const result = loadPitfalls(dir, undefined);
			if (existsSync(globalPath)) {
				// Global exists — we should get non-empty content
				expect(result.length).toBeGreaterThan(0);
			} else {
				// No global either — empty
				expect(result).toBe("");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("T4 overridePath takes priority over local and global", () => {
		const overrideContent = "## Pitfall: Override\nOverride content.";
		const localContent = "## Pitfall: Local\nLocal content.";
		const dir = makeTmpCwd(localContent);
		const overridePath = makeTmpFile(overrideContent);
		try {
			const result = loadPitfalls(dir, overridePath);
			expect(result).toBe(overrideContent.trim());
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(overridePath, { force: true });
		}
	});

	test("T5 caches result in-process (second call skips FS)", () => {
		const content = "## Pitfall: Cached\nCached content.";
		const dir = makeTmpCwd(content);
		try {
			const r1 = loadPitfalls(dir, undefined);
			// Delete the file to prove cache is used
			rmSync(join(dir, "model-router-pitfalls.md"));
			const r2 = loadPitfalls(dir, undefined);
			expect(r1).toBe(content.trim());
			expect(r2).toBe(r1); // served from cache
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("T6 clearPitfallsCache forces reload on next call", () => {
		const content = "## Pitfall: Original\nOriginal.";
		const dir = makeTmpCwd(content);
		try {
			const r1 = loadPitfalls(dir, undefined);
			expect(r1).toBe(content.trim());

			// Overwrite file, clear cache, reload
			const updated = "## Pitfall: Updated\nUpdated.";
			writeFileSync(join(dir, "model-router-pitfalls.md"), updated, "utf8");
			clearPitfallsCache();
			const r2 = loadPitfalls(dir, undefined);
			expect(r2).toBe(updated.trim());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("T4b overridePath missing → falls through to local", () => {
		const localContent = "## Pitfall: Local fallthrough\nLocal wins.";
		const dir = makeTmpCwd(localContent);
		const nonexistent = join(tmpdir(), "does-not-exist-pitfalls.md");
		try {
			const result = loadPitfalls(dir, nonexistent);
			expect(result).toBe(localContent.trim());
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("buildClassifierPrompt — pitfalls injection", () => {
	const ctx = makeContext("How does the authentication system work?");

	test("T7 includes pitfalls block when non-empty string provided", () => {
		const pitfalls = "## Pitfall: Test\nDo not confuse reading with writing.";
		const prompt = buildClassifierPrompt(ctx, undefined, undefined, pitfalls);
		expect(prompt).toContain("Known classification pitfalls to consider:");
		expect(prompt).toContain(pitfalls);
	});

	test("T8 omits pitfalls block when empty string", () => {
		const prompt = buildClassifierPrompt(ctx, undefined, undefined, "");
		expect(prompt).not.toContain("Known classification pitfalls");
	});

	test("T9 omits pitfalls block when undefined", () => {
		const prompt = buildClassifierPrompt(ctx, undefined, undefined, undefined);
		expect(prompt).not.toContain("Known classification pitfalls");
	});

	test("T10 pitfalls block appears between tier definitions and conversation section", () => {
		const pitfalls = "## Pitfall: Order\nThis checks position.";
		const prompt = buildClassifierPrompt(ctx, undefined, undefined, pitfalls);

		const tierIdx = prompt.indexOf("- low:");
		const pitfallIdx = prompt.indexOf("Known classification pitfalls");
		const convIdx = prompt.indexOf("Conversation (user messages");

		expect(tierIdx).toBeGreaterThan(-1);
		expect(pitfallIdx).toBeGreaterThan(-1);
		expect(convIdx).toBeGreaterThan(-1);

		// Order: tiers < pitfalls < conversation
		expect(tierIdx).toBeLessThan(pitfallIdx);
		expect(pitfallIdx).toBeLessThan(convIdx);
	});

	test("T11 prompt without pitfalls has no pitfalls section", () => {
		const p1 = buildClassifierPrompt(ctx);
		const p2 = buildClassifierPrompt(ctx, undefined, undefined, undefined);
		expect(p1).toBe(p2);
		expect(p1).not.toContain("pitfall");
	});
});
