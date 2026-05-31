import { describe, test, expect } from "bun:test";
import { renderUsageReport, type CompressionDiagnostic } from "../src/ui";
import type { RouterConfig } from "../src/types";

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const makeTheme = (): any => ({
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	dim: (text: string) => text,
});

const baseProfile: RouterConfig["profiles"][string] = {
	high: { model: "anthropic/claude-sonnet-4-5" },
	medium: { model: "anthropic/claude-sonnet-4-5" },
	low: { model: "anthropic/claude-haiku-4-5" },
};

const baseInput = {
	theme: makeTheme(),
	selectedProfile: "default",
	profile: baseProfile,
	usageLedger: [],
	lastDecision: undefined,
	modelRegistry: { find: () => ({ contextWindow: 200_000 }) },
};

describe("Usage report — compression diagnostic", () => {
	test("progressive mode shows context tokens vs threshold and cache time", () => {
		const diagnostic: CompressionDiagnostic = {
			mode: "progressive",
			contextTokens: 12_345,
			contextThresholdTokens: 160_000,
			secondsSinceLastTurn: 42,
			timeThresholdSeconds: 300,
		};
		const report = stripAnsi(renderUsageReport({
			...baseInput,
			compression: {
				enabled: true,
				requestCount: 0,
				totalOriginalChars: 0,
				totalCompressedChars: 0,
				diagnostic,
			},
		}));

		expect(report).toContain("progressive mode");
		expect(report).toContain("12.3k / 160.0k tokens");
		expect(report).toContain("42s / 300s timeout");
		expect(report).not.toContain("history too short");
	});

	test("static mode shows current turn vs freezeAfter", () => {
		const diagnostic: CompressionDiagnostic = {
			mode: "static",
			currentTurn: 3,
			freezeAfter: 5,
		};
		const report = stripAnsi(renderUsageReport({
			...baseInput,
			compression: {
				enabled: true,
				requestCount: 0,
				totalOriginalChars: 0,
				totalCompressedChars: 0,
				diagnostic,
			},
		}));

		expect(report).toContain("static mode");
		expect(report).toContain("freezes at turn 5");
		expect(report).toContain("current turn 3 / 5");
		expect(report).not.toContain("history too short");
	});

	test("default mode shows messageCount vs keepLastN", () => {
		const diagnostic: CompressionDiagnostic = {
			mode: "default",
			messageCount: 2,
			keepLastN: 4,
		};
		const report = stripAnsi(renderUsageReport({
			...baseInput,
			compression: {
				enabled: true,
				requestCount: 0,
				totalOriginalChars: 0,
				totalCompressedChars: 0,
				diagnostic,
			},
		}));

		expect(report).toContain("default mode");
		expect(report).toContain("2 messages in history");
		expect(report).toContain("keepLastN=4");
		expect(report).toContain("need at least 5");
		expect(report).not.toContain("history too short");
	});

	test("falls back to generic message when diagnostic missing", () => {
		const report = stripAnsi(renderUsageReport({
			...baseInput,
			compression: {
				enabled: true,
				requestCount: 0,
				totalOriginalChars: 0,
				totalCompressedChars: 0,
			},
		}));

		expect(report).toContain("no compressions yet");
	});

	test("shows compression stats when requestCount > 0 (no diagnostic shown)", () => {
		const report = stripAnsi(renderUsageReport({
			...baseInput,
			compression: {
				enabled: true,
				requestCount: 3,
				totalOriginalChars: 100_000,
				totalCompressedChars: 25_000,
			},
		}));

		expect(report).toContain("3 requests compressed");
		expect(report).toContain("↓75%");
		expect(report).not.toContain("progressive mode");
		expect(report).not.toContain("default mode");
	});
});
