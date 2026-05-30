import { describe, it, expect } from "bun:test";
import { resolveCompressionConfig } from "../src/context-compression";
import type { HistoryCompressionConfig } from "../src/types";

/**
 * Test resolveCompressionConfig merges the progressive field.
 * 
 * Bug: resolveCompressionConfig did NOT merge progressive field from globalConfig/profileConfig,
 * causing provider.ts to fall through to backward-compatible unconditional compression
 * even when progressive.enabled: true was set in user config.
 */

describe("resolveCompressionConfig: progressive field merge", () => {
	it("should merge progressive from globalConfig when profileConfig has none", () => {
		const globalConfig: HistoryCompressionConfig = {
			enabled: true,
			keepLastN: 4,
			progressive: {
				enabled: true,
				contextThreshold: 0.8,
				timeThreshold: 300,
			},
		};

		const resolved = resolveCompressionConfig(globalConfig, undefined);

		expect(resolved).toBeDefined();
		expect(resolved!.enabled).toBe(true);
		expect(resolved!.keepLastN).toBe(4);
		expect(resolved!.progressive).toBeDefined();
		expect(resolved!.progressive!.enabled).toBe(true);
		expect(resolved!.progressive!.contextThreshold).toBe(0.8);
		expect(resolved!.progressive!.timeThreshold).toBe(300);
	});

	it("should merge progressive from profileConfig when globalConfig has none", () => {
		const globalConfig: HistoryCompressionConfig = {
			enabled: true,
			keepLastN: 4,
		};

		const profileConfig: HistoryCompressionConfig = {
			enabled: true,
			progressive: {
				enabled: true,
				contextThreshold: 0.6,
				timeThreshold: 600,
			},
		};

		const resolved = resolveCompressionConfig(globalConfig, profileConfig);

		expect(resolved).toBeDefined();
		expect(resolved!.progressive).toBeDefined();
		expect(resolved!.progressive!.enabled).toBe(true);
		expect(resolved!.progressive!.contextThreshold).toBe(0.6);
		expect(resolved!.progressive!.timeThreshold).toBe(600);
	});

	it("should prefer profileConfig progressive over globalConfig", () => {
		const globalConfig: HistoryCompressionConfig = {
			enabled: true,
			progressive: {
				enabled: false,
				contextThreshold: 0.9,
				timeThreshold: 100,
			},
		};

		const profileConfig: HistoryCompressionConfig = {
			enabled: true,
			progressive: {
				enabled: true,
				contextThreshold: 0.7,
				timeThreshold: 200,
			},
		};

		const resolved = resolveCompressionConfig(globalConfig, profileConfig);

		expect(resolved).toBeDefined();
		expect(resolved!.progressive).toBeDefined();
		expect(resolved!.progressive!.enabled).toBe(true);
		expect(resolved!.progressive!.contextThreshold).toBe(0.7);
		expect(resolved!.progressive!.timeThreshold).toBe(200);
	});

	it("should handle undefined progressive gracefully", () => {
		const globalConfig: HistoryCompressionConfig = {
			enabled: true,
			keepLastN: 4,
		};

		const resolved = resolveCompressionConfig(globalConfig, undefined);

		expect(resolved).toBeDefined();
		expect(resolved!.enabled).toBe(true);
		expect(resolved!.progressive).toBeUndefined();
	});

	it("should NOT trigger unconditional compression when progressive.enabled: true", () => {
		// Reproduce user scenario: globalConfig has progressive.enabled: true
		const globalConfig: HistoryCompressionConfig = {
			enabled: true,
			keepLastN: 4,
			progressive: {
				enabled: true,
				contextThreshold: 0.8,
				timeThreshold: 300,
			},
		};

		const resolved = resolveCompressionConfig(globalConfig, undefined);

		// ✅ resolved config MUST have progressive field
		expect(resolved).toBeDefined();
		expect(resolved!.progressive).toBeDefined();
		expect(resolved!.progressive!.enabled).toBe(true);

		// This allows provider.ts to enter progressive mode (line 482):
		// if (compressionCfg.progressive?.enabled) { ... }
		// instead of falling through to backward-compatible unconditional compression (line 575)
	});
});
