// Calibration system — sync LLM classifier with confusion-matrix learning

export type {
	SessionCalibration,
	GlobalCalibrationSnapshot,
	TraceRecord,
	CalibrationConfig,
	TierIndex,
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
	cancelPendingSave,
} from "./global";

export {
	openTraceFile,
	appendTraceRecord,
	truncatePrompt,
} from "./trace";
