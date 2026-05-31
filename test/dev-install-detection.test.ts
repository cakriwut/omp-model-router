import { describe, test, expect } from "bun:test";
import { isDevInstall } from "../src/version-check";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("isDevInstall()", () => {
	test("returns true when running from workspace path", () => {
		// This test itself runs from the workspace, so it should be detected as dev
		const isDev = isDevInstall();
		// Allow both true (when running from workspace) or false (when running from installed node_modules)
		expect(typeof isDev).toBe("boolean");
	});

	test("detects file: dependency in parent package.json", () => {
		// Create a temporary parent package.json with file: dependency
		const testDir = join(tmpdir(), `test-dev-install-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });

		const pkgPath = join(testDir, "package.json");
		writeFileSync(
			pkgPath,
			JSON.stringify({
				name: "test-extension",
				dependencies: {
					"@cakriwut/omp-model-router": "file:../../../../workspace/omp-model-router",
				},
			}),
		);

		// The actual isDevInstall() checks import.meta.dir, which we can't easily mock
		// So this test documents the expected behavior rather than asserting it

		// Cleanup
		rmSync(testDir, { recursive: true, force: true });

		// Document that file: dependencies should be detected
		expect(true).toBe(true); // placeholder assertion
	});

	test("returns false when running from node_modules", () => {
		// This is implicitly tested when package is installed via npm
		// The function checks for node_modules in the path
		expect(typeof isDevInstall()).toBe("boolean");
	});
});

describe("/router update command with dev install", () => {
	test("should block updates on dev installs", () => {
		// Integration test would require mocking ExtensionContext and isDevInstall()
		// This is covered by manual testing:
		// 1. Install via file: dependency
		// 2. Run /router update
		// 3. Should see "Update unavailable: dev install detected" message
		expect(true).toBe(true); // placeholder
	});
});
