/**
 * Embargo utilities: error classification, retry-after parsing, and duration computation.
 */
import type { EmbargoConfig } from "./types";

// ─── Retryable HTTP status codes ─────────────────────────────────────────────

const RETRYABLE_STATUSES = new Set([429, 502, 503, 529]);
const NON_RETRYABLE_STATUSES = new Set([400, 401, 403]);

/** Text patterns indicating a retryable error when no HTTP status is available. */
const RETRYABLE_TEXT_PATTERNS = [
	/rate.limit/i,
	/overloaded/i,
	/throttl/i,
	/too many requests/i,
	/capacity/i,
	/service.unavailable/i,
	/stream idle timeout/i,
];

/**
 * Classify an error as retryable (should trigger embargo) or not.
 *
 * @param status  HTTP status code from `AssistantMessage.errorStatus` (may be undefined)
 * @param message Error message text from `AssistantMessage.errorMessage`
 * @returns true if the error is retryable and should trigger embargo
 */
export function isRetryableStatus(
	status: number | undefined,
	message: string,
): boolean {
	if (status !== undefined) {
		if (NON_RETRYABLE_STATUSES.has(status)) return false;
		if (RETRYABLE_STATUSES.has(status)) return true;
		// Unknown status — fall through to text heuristic
	}
	// No status or unrecognized status — use text heuristic
	return RETRYABLE_TEXT_PATTERNS.some((pattern) => pattern.test(message));
}

// ─── Retry-After parsing ─────────────────────────────────────────────────────

const RETRY_AFTER_MS_RE = /retry-after-ms=(\d+)/;

/**
 * Extract the `retry-after-ms=<value>` hint embedded in error messages by
 * pi-ai's `formatErrorMessageWithRetryAfter` utility.
 *
 * @param errorMessage The full error message string
 * @returns Parsed milliseconds, or undefined if not present
 */
export function parseRetryAfterMs(errorMessage: string): number | undefined {
	const match = errorMessage.match(RETRY_AFTER_MS_RE);
	if (!match) return undefined;
	const value = parseInt(match[1], 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

// ─── Duration computation ────────────────────────────────────────────────────

/** Default embargo config values (matches FALLBACK_CONFIG). */
const DEFAULT_COOLDOWN_MS = 60_000;
const MIN_COOLDOWN_MS = 5_000;
const MAX_COOLDOWN_MS = 3_600_000;

/**
 * Compute the effective embargo duration, applying clamp(min, max) to the
 * provider-signaled value or falling back to the configured default.
 *
 * @param retryAfterMs  Parsed retry-after-ms from error message (may be undefined)
 * @param config        EmbargoConfig from router config
 * @returns Duration in milliseconds to embargo the model
 */
export function computeEmbargoDuration(
	retryAfterMs: number | undefined,
	config: EmbargoConfig,
): number {
	const defaultMs = config.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
	const minMs = config.minCooldownMs ?? MIN_COOLDOWN_MS;
	const maxMs = config.maxCooldownMs ?? MAX_COOLDOWN_MS;
	const raw = retryAfterMs ?? defaultMs;
	return Math.max(minMs, Math.min(maxMs, raw));
}

// ─── StatusAwareError ────────────────────────────────────────────────────────

/**
 * Error class that preserves HTTP status and retry-after information from
 * stream error events, enabling the catch block to make embargo decisions.
 */
export class StatusAwareError extends Error {
	/** HTTP status code (429, 503, etc.) or undefined if not available. */
	readonly status: number | undefined;
	/** Parsed retry-after-ms value from the error message. */
	readonly retryAfterMs: number | undefined;

	constructor(message: string, status: number | undefined, retryAfterMs: number | undefined) {
		super(message);
		this.name = "StatusAwareError";
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}
