import { readFileSync, writeFileSync, mkdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Constants ────────────────────────────────────────────────────────────────

const PACKAGE_NAME = "@cakriwut/omp-model-router";
const REGISTRY_URL = `https://registry.npmjs.org/${PACKAGE_NAME}/latest`;
const CACHE_DIR = join(homedir(), ".cache", "omp-model-router");
const CACHE_FILE = join(CACHE_DIR, "update-check.json");
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const FETCH_TIMEOUT_MS = 5000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UpdateInfo {
	current: string;
	latest: string;
	updateAvailable: boolean;
}

interface CacheEntry {
	latestVersion: string;
	checkedAt: number;
}

// ─── Version comparison ───────────────────────────────────────────────────────

function parseVersion(version: string): [number, number, number] | undefined {
	const match = version
		.trim()
		.match(/^v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+.*)?$/);
	if (!match) return undefined;
	return [
		Number.parseInt(match[1], 10),
		Number.parseInt(match[2], 10),
		Number.parseInt(match[3], 10),
	];
}

/** Returns true if `candidate` is strictly newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
	const a = parseVersion(candidate);
	const b = parseVersion(current);
	if (!a || !b) return false;
	if (a[0] !== b[0]) return a[0] > b[0];
	if (a[1] !== b[1]) return a[1] > b[1];
	return a[2] > b[2];
}

// ─── Dev install detection ────────────────────────────────────────────────────

/** Returns true when running from a symlinked dev workspace (skip update check). */
export function isDevInstall(): boolean {
	const moduleDir = import.meta.dir;
	try {
		const stat = lstatSync(moduleDir);
		if (stat.isSymbolicLink()) return true;
	} catch {
		// lstat can fail if path is unusual; fall through
	}
	// Heuristic: development installs typically live under ~/workspace/
	// while npm-installed packages live under node_modules/
	if (
		moduleDir.includes("/workspace/") &&
		!moduleDir.includes("node_modules")
	) {
		return true;
	}
	return false;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function readCache(): CacheEntry | undefined {
	try {
		const raw = readFileSync(CACHE_FILE, "utf-8");
		const data = JSON.parse(raw) as CacheEntry;
		if (
			typeof data.latestVersion === "string" &&
			typeof data.checkedAt === "number"
		) {
			return data;
		}
	} catch {
		// Missing or corrupt cache — treat as absent
	}
	return undefined;
}

function writeCache(entry: CacheEntry): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify(entry));
	} catch {
		// Non-critical — silently ignore
	}
}

// ─── Registry fetch ───────────────────────────────────────────────────────────

async function fetchLatestVersion(): Promise<string | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const response = await fetch(REGISTRY_URL, {
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});
		if (!response.ok) return undefined;
		const data = (await response.json()) as { version?: string };
		return typeof data.version === "string" ? data.version : undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the current package version read from package.json.
 * Uses import.meta.dir to locate the file relative to this module.
 */
export function getCurrentVersion(): string {
	const pkgPath = join(import.meta.dir, "package.json");
	try {
		const raw = readFileSync(pkgPath, "utf-8");
		const pkg = JSON.parse(raw) as { version?: string };
		return pkg.version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/**
 * Check for a newer version on npm. Uses a file-based cache with 4h TTL.
 * Returns undefined if no update is available or detection is skipped.
 * Never throws.
 */
export async function checkForUpdate(): Promise<UpdateInfo | undefined> {
	if (isDevInstall()) return undefined;

	const current = getCurrentVersion();
	if (current === "0.0.0") return undefined;

	// Check cache first
	const cached = readCache();
	if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
		if (isNewer(cached.latestVersion, current)) {
			return {
				current,
				latest: cached.latestVersion,
				updateAvailable: true,
			};
		}
		return undefined;
	}

	// Fetch from registry
	const latest = await fetchLatestVersion();
	if (!latest) return undefined;

	// Persist cache
	writeCache({ latestVersion: latest, checkedAt: Date.now() });

	if (isNewer(latest, current)) {
		return { current, latest, updateAvailable: true };
	}
	return undefined;
}
