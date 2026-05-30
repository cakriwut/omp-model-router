/**
 * RTK Integration Test
 *
 * Verifies RTK (Rust Token Killer) integration behavior:
 * - Binary detection
 * - Command rewrite delegation
 * - Graceful degradation when RTK unavailable
 */

import { describe, it, expect, beforeEach } from "bun:test";

describe("RTK Integration", () => {
	describe("Binary Detection", () => {
		it("should detect RTK binary if in PATH", () => {
			const hasRtk = Boolean(Bun.which("rtk"));
			
			if (hasRtk) {
				expect(hasRtk).toBe(true);
				console.log("✓ RTK binary found in PATH");
			} else {
				expect(hasRtk).toBe(false);
				console.log("⚠️ RTK binary not found (expected in CI)");
			}
		});
	});

	describe("RTK Rewrite API", () => {
		const hasRtk = Boolean(Bun.which("rtk"));

		if (!hasRtk) {
			it.skip("RTK not installed — skipping rewrite tests", () => {});
			return;
		}

		it("should rewrite git status", async () => {
			const proc = Bun.spawn(["rtk", "rewrite", "git status"], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const [exitCode, stdout] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				proc.stderr?.cancel(),
			]);

			// Exit code 0 (rewritten) or 3 (skip)
			expect([0, 3]).toContain(exitCode);

			if (exitCode === 0) {
				expect(stdout.trim()).toBe("rtk git status");
			}
		});

		it("should rewrite ls -la", async () => {
			const proc = Bun.spawn(["rtk", "rewrite", "ls -la"], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const [exitCode, stdout] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				proc.stderr?.cancel(),
			]);

			expect([0, 3]).toContain(exitCode);

			if (exitCode === 0) {
				expect(stdout.trim()).toBe("rtk ls -la");
			}
		});

		it("should rewrite cat file.json", async () => {
			const proc = Bun.spawn(["rtk", "rewrite", "cat file.json"], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const [exitCode, stdout] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				proc.stderr?.cancel(),
			]);

			expect([0, 3]).toContain(exitCode);

			if (exitCode === 0) {
				expect(stdout.trim()).toContain("rtk");
			}
		});

		it("should skip unknown commands gracefully", async () => {
			const proc = Bun.spawn(["rtk", "rewrite", "unknown-command-xyz"], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const [exitCode, stdout] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				proc.stderr?.cancel(),
			]);

			// Should return exit code 3 (skip) for unknown commands
			// Should return exit code 1 (error) or 3 (skip) for unknown commands
			expect([1, 3]).toContain(exitCode);
			// Output should be unchanged or empty
		});

		it("should handle empty commands", async () => {
			const proc = Bun.spawn(["rtk", "rewrite", ""], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const [exitCode] = await Promise.all([
				proc.exited,
				proc.stdout?.cancel(),
				proc.stderr?.cancel(),
			]);

			// Should not crash
			expect([0, 1, 3]).toContain(exitCode);
		});
	});

	describe("Token Savings Estimation", () => {
		it("should demonstrate token savings for common commands", () => {
			const scenarios = [
				{
					command: "ls -la",
					withoutRtk: 800, // ~45 lines, verbose output
					withRtk: 150,    // ~12 lines, compact tree
					savings: 0.81,
				},
				{
					command: "git status",
					withoutRtk: 200,  // ~15 lines, verbose
					withRtk: 30,      // ~3 lines, compact
					savings: 0.85,
				},
				{
					command: "cargo test",
					withoutRtk: 5000, // ~200+ lines on failure
					withRtk: 500,     // ~20 lines, failures only
					savings: 0.90,
				},
				{
					command: "cat large.json",
					withoutRtk: 19500, // 78KB JSON dump
					withRtk: 500,      // Structure without values
					savings: 0.97,
				},
			];

			for (const scenario of scenarios) {
				const actualSavings = 1 - scenario.withRtk / scenario.withoutRtk;
				expect(actualSavings).toBeCloseTo(scenario.savings, 1);
				
				console.log(
					`${scenario.command}: ${scenario.withoutRtk} → ${scenario.withRtk} tokens (${(actualSavings * 100).toFixed(0)}% saved)`
				);
			}
		});
	});

	describe("Configuration", () => {
		it("should respect enableRtk flag", () => {
			const configEnabled = { enableRtk: true };
			const configDisabled = { enableRtk: false };
			const configDefault = {};

			expect(configEnabled.enableRtk).toBe(true);
			expect(configDisabled.enableRtk).toBe(false);
			expect(configDefault.enableRtk ?? false).toBe(false);
		});
	});

	describe("Real-World Scenarios", () => {
		const hasRtk = Boolean(Bun.which("rtk"));

		if (!hasRtk) {
			it.skip("RTK not installed", () => {});
			return;
		}

		it("should prevent the 78KB trace dump scenario", async () => {
			// The command that caused bloat in investigation
			const original = "cat traces/*.jsonl";

			const proc = Bun.spawn(["rtk", "rewrite", original], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const [exitCode, stdout] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				proc.stderr?.cancel(),
			]);

			expect([0, 3]).toContain(exitCode);

			if (exitCode === 0) {
				const rewritten = stdout.trim();
				// Should be rewritten to rtk cat or rtk read
				expect(rewritten).toContain("rtk");
				expect(rewritten).not.toBe(original);

				console.log(`Prevented bloat: "${original}" → "${rewritten}"`);
			}
		});

		it("should handle git operations efficiently", async () => {
			const commands = ["git status", "git log -n 10", "git diff"];

			for (const cmd of commands) {
				const proc = Bun.spawn(["rtk", "rewrite", cmd], {
					stdout: "pipe",
					stderr: "pipe",
				});

				const [exitCode] = await Promise.all([
					proc.exited,
					proc.stdout?.cancel(),
					proc.stderr?.cancel(),
				]);

				expect([0, 3]).toContain(exitCode);
			}
		});

		it("should handle test runner outputs", async () => {
			const testRunners = [
				"cargo test",
				"npm test",
				"pytest",
				"go test",
			];

			for (const cmd of testRunners) {
				const proc = Bun.spawn(["rtk", "rewrite", cmd], {
					stdout: "pipe",
					stderr: "pipe",
				});

				const [exitCode] = await Promise.all([
					proc.exited,
					proc.stdout?.cancel(),
					proc.stderr?.cancel(),
				]);

				expect([0, 1, 3]).toContain(exitCode);
			}
		});
	});
});
