/**
 * Unit tests for getBucket dominance algorithm (Phase 2: classifier-tool-mix-signal)
 */
import { describe, test, expect } from "bun:test";
import { getBucket } from "../src/utils/messages";

describe("getBucket", () => {
	test("empty counts → fresh", () => {
		expect(getBucket({})).toBe("fresh");
	});

	test("single call → fresh (total < 2)", () => {
		expect(getBucket({ read: 1 })).toBe("fresh");
	});

	test("exploration dominance (8/8 = 100%)", () => {
		expect(getBucket({ read: 5, search: 1, find: 1, ast_grep: 1 })).toBe("exploration");
	});

	test("exploration combined (read + search, 100%)", () => {
		expect(getBucket({ read: 5, search: 5 })).toBe("exploration");
	});

	test("implementation dominance (66.7% ≥ 60%)", () => {
		// edit×3, read×1, write×1, bash×1 → implementation = 4/6 ≈ 66.7%
		expect(getBucket({ read: 1, edit: 3, write: 1, bash: 1 })).toBe("implementation");
	});

	test("delegation dominance (100%)", () => {
		expect(getBucket({ task: 5, eval: 3 })).toBe("delegation");
	});

	test("mixed — no category reaches 60%", () => {
		// read×2, edit×2, bash×1, debug×1 → exploration=2/6=33%, implementation=2/6=33%
		expect(getBucket({ read: 2, edit: 2, bash: 1, debug: 1 })).toBe("mixed");
	});

	test("bash unmapped → other → resolves to mixed", () => {
		// 10 bash calls, none mapped to a named bucket → other wins denominator but not winner
		expect(getBucket({ bash: 10 })).toBe("mixed");
	});

	test("unknown tool → other → resolves to mixed", () => {
		expect(getBucket({ unknown_tool: 10 })).toBe("mixed");
	});

	test("exact 60% threshold → exploration wins (uses >=)", () => {
		// read×6, edit×4 → exploration = 6/10 = 60.0% exactly → should win
		expect(getBucket({ read: 6, edit: 4 })).toBe("exploration");
	});

	test("just below 60% → mixed", () => {
		// read×5, edit×4, bash×1 → exploration = 5/10 = 50% < 60%
		expect(getBucket({ read: 5, edit: 4, bash: 1 })).toBe("mixed");
	});

	test("mixed read+edit with equal counts → mixed", () => {
		expect(getBucket({ read: 3, edit: 3 })).toBe("mixed");
	});

	test("verification via debug (100%)", () => {
		expect(getBucket({ debug: 5 })).toBe("verification");
	});
});
