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

/** 
 * Returns true when running from a dev install (skip update check).
 * Detects:
 * - Symlinked extension directories
 * - Workspace-relative paths
 * - file:... dependencies in package.json
 */
export function isDevInstall(): boolean {
	const moduleDir = import.meta.dir;
	
	// Check for symlinks
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
	
	// Check if installed via file: dependency in parent package.json
	// This happens when users do: bun add file:../../../../workspace/omp-model-router
	// or when deploy:dev script creates a local link
	try {
		// Walk up to find the extension's package.json
		let checkDir = moduleDir;
		for (let i = 0; i < 5; i++) {
			const parentPkg = join(checkDir, "..", "package.json");
			try {
				const pkg = JSON.parse(readFileSync(parentPkg, "utf-8"));
				const deps = { ...pkg.dependencies, ...pkg.devDependencies };
				// Check if this package is listed as a file: dependency
				if (deps[PACKAGE_NAME]?.startsWith("file:")) {
					return true;
				}
			} catch {
				// Not found or parse error, try parent
			}
			checkDir = join(checkDir, "..");
		}
	} catch {
		// Ignore errors during file: dependency detection
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
 * Walks up from import.meta.dir to find the package.json with matching name,
 * which handles different installation layouts (npm, dev, bundled).
 */
export function getCurrentVersion(): string {
	let dir = import.meta.dir;
	// Walk up to 6 levels looking for our package.json
	for (let i = 0; i < 6; i++) {
		const pkgPath = join(dir, "package.json");
		try {
			const raw = readFileSync(pkgPath, "utf-8");
			const pkg = JSON.parse(raw) as { name?: string; version?: string };
			// Verify this is our package, not a parent's wrapper
			if (pkg.name === PACKAGE_NAME && pkg.version) {
				return pkg.version;
			}
		} catch {
			// File not found or parse error, continue walking up
		}
		const parent = join(dir, "..");
		if (parent === dir) break; // Hit root
		dir = parent;
	}
	return "unknown";
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
