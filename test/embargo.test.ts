import { describe, expect, test } from "bun:test";
import {
	isRetryableStatus,
	parseRetryAfterMs,
	computeEmbargoDuration,
	StatusAwareError,
} from "../src/embargo";
import type { EmbargoConfig } from "../src/types";

// ─── isRetryableStatus ───────────────────────────────────────────────────────

describe("isRetryableStatus", () => {
	test("429 is retryable", () => {
		expect(isRetryableStatus(429, "Rate limit exceeded")).toBe(true);
	});

	test("503 is retryable", () => {
		expect(isRetryableStatus(503, "Service unavailable")).toBe(true);
	});

	test("529 is retryable (Anthropic overloaded)", () => {
		expect(isRetryableStatus(529, "Overloaded")).toBe(true);
	});

	test("502 is retryable (bad gateway)", () => {
		expect(isRetryableStatus(502, "Bad gateway")).toBe(true);
	});

	test("401 is NOT retryable", () => {
		expect(isRetryableStatus(401, "Unauthorized")).toBe(false);
	});

	test("403 is NOT retryable", () => {
		expect(isRetryableStatus(403, "Forbidden")).toBe(false);
	});

	test("400 is NOT retryable", () => {
		expect(isRetryableStatus(400, "Bad request")).toBe(false);
	});

	test("undefined status with 'rate limit' text is retryable", () => {
		expect(isRetryableStatus(undefined, "You have exceeded your rate limit")).toBe(true);
	});

	test("undefined status with 'overloaded' text is retryable", () => {
		expect(isRetryableStatus(undefined, "Server is overloaded, please try later")).toBe(true);
	});

	test("undefined status with 'throttled' text is retryable", () => {
		expect(isRetryableStatus(undefined, "Request throttled by provider")).toBe(true);
	});

	test("undefined status with 'too many requests' text is retryable", () => {
		expect(isRetryableStatus(undefined, "Too many requests")).toBe(true);
	});

	test("undefined status with unrelated message is NOT retryable", () => {
		expect(isRetryableStatus(undefined, "Internal server error")).toBe(false);
	});

	test("undefined status with 'service unavailable' text is retryable", () => {
		expect(isRetryableStatus(undefined, "The service is currently unavailable")).toBe(false);
		// 'service unavailable' is matched by 'service.unavailable' pattern
		expect(isRetryableStatus(undefined, "service unavailable")).toBe(true);
	});
});

// ─── parseRetryAfterMs ───────────────────────────────────────────────────────

describe("parseRetryAfterMs", () => {
	test("extracts retry-after-ms=30000", () => {
		expect(parseRetryAfterMs("Rate limit exceeded retry-after-ms=30000")).toBe(30000);
	});

	test("extracts retry-after-ms=14400000 (4 hours)", () => {
		expect(parseRetryAfterMs("Daily limit reached retry-after-ms=14400000")).toBe(14400000);
	});

	test("extracts from middle of message", () => {
		expect(parseRetryAfterMs("Error: 429 retry-after-ms=5000 please wait")).toBe(5000);
	});

	test("returns undefined when not present", () => {
		expect(parseRetryAfterMs("Rate limit exceeded")).toBeUndefined();
	});

	test("returns undefined for retry-after-ms=0", () => {
		expect(parseRetryAfterMs("retry-after-ms=0")).toBeUndefined();
	});

	test("returns undefined for malformed (non-numeric)", () => {
		expect(parseRetryAfterMs("retry-after-ms=abc")).toBeUndefined();
	});

	test("handles empty string", () => {
		expect(parseRetryAfterMs("")).toBeUndefined();
	});
});

// ─── computeEmbargoDuration ──────────────────────────────────────────────────

describe("computeEmbargoDuration", () => {
	const defaultConfig: EmbargoConfig = {
		enabled: true,
		defaultCooldownMs: 60_000,
		minCooldownMs: 5_000,
		maxCooldownMs: 3_600_000,
	};

	test("uses retryAfterMs when provided", () => {
		expect(computeEmbargoDuration(30_000, defaultConfig)).toBe(30_000);
	});

	test("uses defaultCooldownMs when retryAfterMs is undefined", () => {
		expect(computeEmbargoDuration(undefined, defaultConfig)).toBe(60_000);
	});

	test("clamps to minCooldownMs when retryAfterMs is too low", () => {
		expect(computeEmbargoDuration(1_000, defaultConfig)).toBe(5_000);
	});

	test("clamps to maxCooldownMs when retryAfterMs is too high", () => {
		expect(computeEmbargoDuration(14_400_000, defaultConfig)).toBe(3_600_000);
	});

	test("Anthropic Max 4-hour retry capped to 1 hour", () => {
		expect(computeEmbargoDuration(4 * 3_600_000, defaultConfig)).toBe(3_600_000);
	});

	test("uses custom config values", () => {
		const custom: EmbargoConfig = {
			enabled: true,
			defaultCooldownMs: 120_000,
			minCooldownMs: 10_000,
			maxCooldownMs: 7_200_000,
		};
		expect(computeEmbargoDuration(undefined, custom)).toBe(120_000);
		expect(computeEmbargoDuration(5_000, custom)).toBe(10_000);
		expect(computeEmbargoDuration(8_000_000, custom)).toBe(7_200_000);
	});

	test("handles config with undefined optional fields (uses built-in defaults)", () => {
		const minimal: EmbargoConfig = { enabled: true };
		expect(computeEmbargoDuration(undefined, minimal)).toBe(60_000);
		expect(computeEmbargoDuration(1_000, minimal)).toBe(5_000);
		expect(computeEmbargoDuration(5_000_000, minimal)).toBe(3_600_000);
	});
});

// ─── StatusAwareError ────────────────────────────────────────────────────────

describe("StatusAwareError", () => {
	test("preserves status and retryAfterMs", () => {
		const err = new StatusAwareError("Rate limited", 429, 30000);
		expect(err.message).toBe("Rate limited");
		expect(err.status).toBe(429);
		expect(err.retryAfterMs).toBe(30000);
		expect(err.name).toBe("StatusAwareError");
		expect(err).toBeInstanceOf(Error);
	});

	test("handles undefined status and retryAfterMs", () => {
		const err = new StatusAwareError("Unknown error", undefined, undefined);
		expect(err.status).toBeUndefined();
		expect(err.retryAfterMs).toBeUndefined();
	});
});
