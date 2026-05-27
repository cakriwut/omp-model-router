import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { isNewer, isDevInstall, getCurrentVersion, checkForUpdate } from "../src/version-check";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── isNewer ──────────────────────────────────────────────────────────────────

describe("isNewer", () => {
	it("returns true when major is higher", () => {
		expect(isNewer("2.0.0", "1.0.0")).toBe(true);
	});

	it("returns true when minor is higher", () => {
		expect(isNewer("1.1.0", "1.0.0")).toBe(true);
	});

	it("returns true when patch is higher", () => {
		expect(isNewer("1.0.1", "1.0.0")).toBe(true);
	});

	it("returns false when versions are equal", () => {
		expect(isNewer("1.0.0", "1.0.0")).toBe(false);
	});

	it("returns false when candidate is older", () => {
		expect(isNewer("1.0.0", "2.0.0")).toBe(false);
		expect(isNewer("0.9.0", "1.0.0")).toBe(false);
		expect(isNewer("1.0.0", "1.0.1")).toBe(false);
	});

	it("handles v-prefix", () => {
		expect(isNewer("v2.0.0", "v1.0.0")).toBe(true);
		expect(isNewer("v1.0.0", "2.0.0")).toBe(false);
	});

	it("ignores prerelease suffix for ordering", () => {
		// Pre-release is stripped for comparison — only major.minor.patch counts
		expect(isNewer("1.1.0-beta.1", "1.0.0")).toBe(true);
		expect(isNewer("1.0.0-alpha", "1.0.0")).toBe(false);
	});

	it("ignores build metadata", () => {
		expect(isNewer("2.0.0+build123", "1.0.0")).toBe(true);
	});

	it("returns false for malformed versions", () => {
		expect(isNewer("invalid", "1.0.0")).toBe(false);
		expect(isNewer("1.0.0", "invalid")).toBe(false);
		expect(isNewer("", "")).toBe(false);
	});
});

// ─── isDevInstall ─────────────────────────────────────────────────────────────

describe("isDevInstall", () => {
	it("returns true for workspace paths (current dev environment)", () => {
		// This test is running from the workspace, so it should detect as dev
		expect(isDevInstall()).toBe(true);
	});
});

// ─── getCurrentVersion ────────────────────────────────────────────────────────

describe("getCurrentVersion", () => {
	it("returns the version from package.json", () => {
		const version = getCurrentVersion();
		// Should match what's in package.json
		expect(version).toMatch(/^\d+\.\d+\.\d+$/);
		expect(version).not.toBe("0.0.0");
	});
});

// ─── checkForUpdate ───────────────────────────────────────────────────────────

describe("checkForUpdate", () => {
	it("returns undefined for dev installs (skips check)", async () => {
		// Since we're running in workspace (dev), it should skip
		const result = await checkForUpdate();
		expect(result).toBeUndefined();
	});
});

// ─── Integration: cache behavior ──────────────────────────────────────────────

describe("cache behavior", () => {
	const cacheDir = join(homedir(), ".cache", "omp-model-router");
	const cacheFile = join(cacheDir, "update-check.json");

	let originalCacheContent: string | undefined;

	beforeEach(() => {
		try {
			const { readFileSync } = require("node:fs");
			originalCacheContent = readFileSync(cacheFile, "utf-8");
		} catch {
			originalCacheContent = undefined;
		}
	});

	afterEach(() => {
		// Restore original cache state
		if (originalCacheContent !== undefined) {
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(cacheFile, originalCacheContent);
		} else if (existsSync(cacheFile)) {
			rmSync(cacheFile);
		}
	});

	it("cache file location is under ~/.cache/omp-model-router/", () => {
		expect(cacheFile).toContain(".cache/omp-model-router/update-check.json");
	});
});
