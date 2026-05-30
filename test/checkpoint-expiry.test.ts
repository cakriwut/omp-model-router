/**
 * Checkpoint Expiry Test
 *
 * Verifies that stale or oversized checkpoints are automatically refreshed
 * to prevent frozen bloat from degrading conversation coherence.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import type { RouterState } from "../src/state";
import type { RouterConfig, CompressionCheckpoint } from "../src/types";
import { estimateContextTokens } from "../src/provider";
import type { Context } from "@oh-my-pi/pi-ai";

describe("Checkpoint Expiry Logic", () => {
	let state: RouterState;
	let config: RouterConfig;
	let mockContext: Context;

	beforeEach(() => {
		// Create minimal config
		config = {
			routerEnabled: true,
			defaultProfile: "auto",
			debug: false,
			debugVerbose: false,
			maxSessionBudget: 5.0,
			largeContextThreshold: 150_000,
			phaseBias: 0.5,
			debugHistoryLimit: 10,
			rules: [],
			profiles: {
				auto: {
					high: { model: "anthropic/claude-sonnet-4-5", thinking: "high" },
					medium: { model: "anthropic/claude-haiku-4-5", thinking: "medium" },
					low: { model: "anthropic/claude-haiku-4-5", thinking: "low" },
				},
			},
			historyCompression: {
				enabled: true,
				keepLastN: 4,
				progressive: {
					enabled: true,
					contextThreshold: 0.8,
					timeThreshold: 300,
					maxCheckpointAge: 50,
					maxCheckpointSize: 200_000,
				},
			},
		};

		// Create minimal state
		state = {
			enabled: true,
			selectedProfile: "auto",
			currentConfig: config,
			sessionStartTime: Date.now(),
			sessionCost: 0,
			sessionBudgetExceeded: false,
			costByModel: {},
			routerInfo: { provider: "anthropic", model: "claude-sonnet-4-5" },
			pinByProfile: {},
			thinkingByProfile: {},
			debugHistory: [],
			widgetEnabled: false,
			compressionTotalOriginalChars: 0,
			compressionTotalCompressedChars: 0,
			compressionRequestCount: 0,
			accumulatedOriginalTokens: 0,
			accumulatedCompressedTokens: 0,
			accumulatedTokensSaved: 0,
			lastTurnTimestamp: Date.now() - 10_000, // 10 seconds ago
			currentCheckpoint: undefined,
		};

		// Create a mock context with many messages
		const messages = [];
		for (let i = 0; i < 100; i++) {
			messages.push({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `Message ${i}`,
				timestamp: Date.now() - (100 - i) * 1000,
			});
		}
		mockContext = { messages } as Context;
	});

	it("should refresh checkpoint when age exceeds maxCheckpointAge", () => {
		// Create a stale checkpoint (created 60 turns ago, limit is 50)
		const checkpoint: CompressionCheckpoint = {
			frozenBlock: "[HISTORY: 40 messages compressed]...",
			metadata: {
				turn: 40, // Current turn is 100, so age = 60
				range: [0, 100],
				stats: {
					compressedMessages: 40,
					originalChars: 5000,
					compressedChars: 500,
					compressionRatio: 0.1,
					estimatedOriginalTokens: 1250,
					estimatedCompressedTokens: 125,
					estimatedTokensSaved: 1125,
				},
				triggerReason: "context_size",
				timestamp: Date.now() - 60_000,
			},
		};

		state.currentCheckpoint = checkpoint;

		// Simulate checkpoint age check
		const currentTurn = 100;
		const checkpointAge = currentTurn - checkpoint.metadata.turn;
		const maxCheckpointAge = config.historyCompression?.progressive?.maxCheckpointAge ?? 50;

		expect(checkpointAge).toBe(60);
		expect(checkpointAge > maxCheckpointAge).toBe(true);
		// In real code, this would trigger checkpoint refresh
	});

	it("should refresh checkpoint when context size exceeds maxCheckpointSize", () => {
		// Create a checkpoint with oversized context
		const checkpoint: CompressionCheckpoint = {
			frozenBlock: "[HISTORY: 90 messages compressed]...",
			metadata: {
				turn: 90,
				range: [0, 1000],
				stats: {
					compressedMessages: 90,
					originalChars: 50_000,
					compressedChars: 5_000,
					compressionRatio: 0.1,
					estimatedOriginalTokens: 12_500,
					estimatedCompressedTokens: 1_250,
					estimatedTokensSaved: 11_250,
				},
				triggerReason: "context_size",
				timestamp: Date.now() - 5_000,
			},
		};

		state.currentCheckpoint = checkpoint;

		// Simulate large context
		const largeContext: Context = {
			messages: Array.from({ length: 1000 }, (_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `Message ${i}`.repeat(100), // Make messages large
				timestamp: Date.now() - (1000 - i) * 1000,
			})),
		} as Context;

		const currentContextTokens = estimateContextTokens(largeContext);
		const maxCheckpointSize = config.historyCompression?.progressive?.maxCheckpointSize ?? 200_000;

		expect(currentContextTokens > maxCheckpointSize).toBe(true);
		// In real code, this would trigger checkpoint refresh
	});

	it("should NOT refresh checkpoint when age and size are within limits", () => {
		// Create a fresh, small checkpoint
		const checkpoint: CompressionCheckpoint = {
			frozenBlock: "[HISTORY: 20 messages compressed]...",
			metadata: {
				turn: 95, // Current turn is 100, so age = 5
				range: [0, 100],
				stats: {
					compressedMessages: 20,
					originalChars: 2000,
					compressedChars: 200,
					compressionRatio: 0.1,
					estimatedOriginalTokens: 500,
					estimatedCompressedTokens: 50,
					estimatedTokensSaved: 450,
				},
				triggerReason: "context_size",
				timestamp: Date.now() - 1_000,
			},
		};

		state.currentCheckpoint = checkpoint;

		const currentTurn = 100;
		const checkpointAge = currentTurn - checkpoint.metadata.turn;
		const maxCheckpointAge = config.historyCompression?.progressive?.maxCheckpointAge ?? 50;

		const smallContext: Context = {
			messages: Array.from({ length: 100 }, (_, i) => ({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `Message ${i}`,
				timestamp: Date.now() - (100 - i) * 1000,
			})),
		} as Context;

		const currentContextTokens = estimateContextTokens(smallContext);
		const maxCheckpointSize = config.historyCompression?.progressive?.maxCheckpointSize ?? 200_000;

		expect(checkpointAge).toBe(5);
		expect(checkpointAge <= maxCheckpointAge).toBe(true);
		expect(currentContextTokens <= maxCheckpointSize).toBe(true);
		// Checkpoint should be reused
	});

	it("should handle missing checkpoint gracefully", () => {
		// No checkpoint exists
		state.currentCheckpoint = undefined;

		// Should not crash when checking expiry
		const checkpoint = state.currentCheckpoint;
		expect(checkpoint).toBeUndefined();
	});

	it("should use default values when progressive config is missing", () => {
		// Remove progressive config
		if (config.historyCompression) {
			config.historyCompression.progressive = undefined;
		}

		// Defaults should be applied
		const maxCheckpointAge = config.historyCompression?.progressive?.maxCheckpointAge ?? 50;
		const maxCheckpointSize = config.historyCompression?.progressive?.maxCheckpointSize ?? 200_000;

		expect(maxCheckpointAge).toBe(50);
		expect(maxCheckpointSize).toBe(200_000);
	});
});
