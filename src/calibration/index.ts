// Calibration system — async LLM classifier with confusion-matrix learning

export type {
	SessionCalibration,
	GlobalCalibrationSnapshot,
	TraceRecord,
	CalibrationConfig,
	TierIndex,
	ClassifierPollResult,
} from "./types";

export {
	initSessionCalibration,
	updateCalibrationMatrix,
	applyCalibratedTier,
	computeAgreementRate,
	computeMismatchRate,
	tierToIndex,
	indexToTier,
} from "./session";

export {
	loadGlobalCalibration,
	mergeSessionIntoGlobal,
	saveGlobalSnapshot,
	resetGlobalCalibration,
} from "./global";

export {
	spawnClassifierAgent,
	pollClassifierResult,
	abandonClassifier,
} from "./agent";

export {
	openTraceFile,
	appendTraceRecord,
	truncatePrompt,
} from "./trace";
