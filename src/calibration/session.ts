import type {
	SessionCalibration,
	GlobalCalibrationSnapshot,
	TierIndex,
	CalibrationConfig,
} from "./types";
import type { RouterTier } from "../types";

/**
 * Initialize a fresh session calibration state
 * Optionally bootstrap from global snapshot
 */
export function initSessionCalibration(
	global?: GlobalCalibrationSnapshot,
	config?: CalibrationConfig,
): SessionCalibration {
	const matrix: number[][] = [
		[0, 0, 0],
		[0, 0, 0],
		[0, 0, 0],
	];

	// Bootstrap from global with prior weight
	if (
		global &&
		config?.useGlobalPrior &&
		config.globalPriorWeight > 0 &&
		global.metadata.totalComparisons > 0
	) {
		const weight = config.globalPriorWeight;
		for (let h = 0; h < 3; h++) {
			for (let l = 0; l < 3; l++) {
				matrix[h][l] = Math.floor(global.matrix[h][l] * weight);
			}
		}
	}

	return {
		matrix,
		totalComparisons: 0,
		llmCallsAttempted: 0,
		llmCallsFailed: 0,
		sessionStartTime: Date.now(),
		turnsProcessed: 0,
	};
}

/**
 * Update confusion matrix with a new heuristic vs LLM verdict pair
 */
export function updateCalibrationMatrix(
	cal: SessionCalibration,
	heuristicTier: RouterTier,
	llmTier: RouterTier,
): void {
	const h = tierToIndex(heuristicTier);
	const l = tierToIndex(llmTier);
	cal.matrix[h][l]++;
	cal.totalComparisons++;
}

/**
 * Apply calibrated tier based on confusion matrix
 * (Strategy A: majority-vote override with confidence threshold)
 *
 * Returns the original tier if:
 * - totalComparisons < warmupTurns (cold start)
 * - Matrix row is empty (no LLM data for this tier)
 * - Majority agrees with heuristic
 * - Confidence < threshold
 *
 * Otherwise returns the majority tier from LLM verdicts
 */
export function applyCalibratedTier(
	rawTier: RouterTier,
	cal: SessionCalibration,
	config: CalibrationConfig,
): RouterTier {
	// Skip calibration during warmup
	if (cal.totalComparisons < config.warmupTurns) {
		return rawTier;
	}

	const h = tierToIndex(rawTier);
	const row = cal.matrix[h]; // [llm_low, llm_medium, llm_high]

	const rowSum = row.reduce((a, b) => a + b, 0);
	if (rowSum === 0) {
		// No LLM data for this heuristic tier yet
		return rawTier;
	}

	const majorityIdx = argmax(row);
	const confidence = row[majorityIdx] / rowSum;

	// Override if: majority ≠ heuristic AND confidence >= threshold
	if (majorityIdx !== h && confidence >= config.overrideThreshold) {
		return indexToTier(majorityIdx);
	}

	return rawTier;
}

/**
 * Compute agreement rate (heuristic == LLM) from confusion matrix
 */
export function computeAgreementRate(cal: SessionCalibration): number {
	if (cal.totalComparisons === 0) return 0;

	// Diagonal = agreements
	const agreements = cal.matrix[0][0] + cal.matrix[1][1] + cal.matrix[2][2];
	return agreements / cal.totalComparisons;
}

/**
 * Compute mismatch rate (heuristic != LLM)
 */
export function computeMismatchRate(cal: SessionCalibration): number {
	return 1 - computeAgreementRate(cal);
}

// ─── Helper functions ─────────────────────────────────────────────────────────

export function tierToIndex(tier: RouterTier): TierIndex {
	switch (tier) {
		case "low":
			return 0;
		case "medium":
			return 1;
		case "high":
			return 2;
	}
}

export function indexToTier(idx: number): RouterTier {
	switch (idx) {
		case 0:
			return "low";
		case 1:
			return "medium";
		case 2:
		default:
			return "high";
	}
}

function argmax(arr: number[]): number {
	let maxIdx = 0;
	let maxVal = arr[0];
	for (let i = 1; i < arr.length; i++) {
		if (arr[i] > maxVal) {
			maxVal = arr[i];
			maxIdx = i;
		}
	}
	return maxIdx;
}
