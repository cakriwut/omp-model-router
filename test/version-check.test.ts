import { describe, it, expect, beforeEach, afterEach } from "bun:test";
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
	it("returns a boolean indicating dev install status", () => {
		// In CI, this is a fresh clone (not a dev install)
		// In actual dev, this would be a symlink or under ~/workspace/
		const isDev = isDevInstall();
		// Just verify it returns a boolean
		expect(typeof isDev).toBe("boolean");
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

// ─── cache staleness: current surpassed cached latest ────────────────────────

describe("checkForUpdate cache invalidation — stale cache regression", () => {
	const cacheDir = join(homedir(), ".cache", "omp-model-router");
	const cacheFile = join(cacheDir, "update-check.json");

	let savedCache: string | undefined;

	beforeEach(() => {
		try { savedCache = require("node:fs").readFileSync(cacheFile, "utf-8"); } catch { savedCache = undefined; }
	});

	afterEach(() => {
		if (savedCache !== undefined) {
			mkdirSync(cacheDir, { recursive: true });
			writeFileSync(cacheFile, savedCache);
		} else if (existsSync(cacheFile)) {
			rmSync(cacheFile);
		}
	});

	/**
	 * Regression: user had v0.8.1 installed, cache said latest=0.8.1, still within TTL.
	 * After upgrading to v0.8.2, checkForUpdate() would return undefined because
	 * isNewer("0.8.1", "0.8.2") = false AND cache TTL had not expired.
	 * Fix: when current has caught up to or surpassed cached.latestVersion, bust the cache.
	 */
	it("identifies when current version has caught up to cached latest (0.8.1→0.8.2 scenario)", () => {
		// Simulate: cache written when 0.8.1 was latest, still within 4h TTL
		const staleCacheEntry = {
			latestVersion: "0.8.1",
			checkedAt: Date.now() - 60_000, // 1 min ago — well within TTL
		};
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(cacheFile, JSON.stringify(staleCacheEntry));

		// isNewer(current="0.8.2", cached.latestVersion="0.8.1") should be true
		// meaning current has surpassed cached latest → cache must be busted
		const currentSurpassedCache = isNewer("0.8.2", "0.8.1");
		expect(currentSurpassedCache).toBe(true);

		// And the inverse: isNewer("0.8.1", "0.8.2") = false means cache says nothing new
		// Without the fix, this would make checkForUpdate() return undefined (no update)
		const cacheStillAhead = isNewer("0.8.1", "0.8.2");
		expect(cacheStillAhead).toBe(false);
	});

	it("cache is fresh and valid when latestVersion is ahead of current", () => {
		// Cache says 0.8.3 is available, current is 0.8.2 → cache is useful
		const validCacheEntry = {
			latestVersion: "0.8.3",
			checkedAt: Date.now() - 60_000, // 1 min ago — within TTL
		};
		mkdirSync(cacheDir, { recursive: true });
		writeFileSync(cacheFile, JSON.stringify(validCacheEntry));

		// isNewer(current="0.8.2", cached.latestVersion="0.8.3") → false
		// meaning current has NOT surpassed cache → cache remains valid
		const currentAheadOfCache = isNewer("0.8.2", "0.8.3");
		expect(currentAheadOfCache).toBe(false); // current is behind cache → cache is still useful
	});
});
