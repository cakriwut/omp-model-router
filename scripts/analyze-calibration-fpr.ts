#!/usr/bin/env bun
/**
 * Analyze residual false-positive rate from 2-week calibration window.
 * 
 * Run after June 18, 2026:
 *   bun scripts/analyze-calibration-fpr.ts
 * 
 * Measures: FP rate = (matrix[2][0] + matrix[2][1]) / totalComparisons
 * - matrix[2][0]: heuristic=high, llm=low
 * - matrix[2][1]: heuristic=high, llm=medium
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface GlobalCalibrationSnapshot {
	version: 1;
	matrix: number[][];
	metadata: {
		totalSessions: number;
		totalComparisons: number;
		lastUpdated: number;
		routerVersion: string;
	};
}

function loadGlobalCalibration(): GlobalCalibrationSnapshot | null {
	try {
		const filePath = join(
			homedir(),
			".omp/agent/model-router/calibration-global.json"
		);
		const data = JSON.parse(readFileSync(filePath, "utf-8"));
		return data as GlobalCalibrationSnapshot;
	} catch (e) {
		console.error("Failed to load calibration file:", e);
		return null;
	}
}

function analyzeFPR(snapshot: GlobalCalibrationSnapshot): void {
	const { matrix, metadata } = snapshot;

	// Matrix indices: 0=low, 1=medium, 2=high
	// False positives: heuristic=high but LLM said low or medium
	const fpLow = matrix[2]?.[0] ?? 0;
	const fpMedium = matrix[2]?.[1] ?? 0;
	const fpTotal = fpLow + fpMedium;

	const { totalComparisons, totalSessions, lastUpdated, routerVersion } =
		metadata;
	const fprPercent = (fpTotal / totalComparisons) * 100;

	const lastUpdatedDate = new Date(lastUpdated).toISOString();

	console.log(`
╔════════════════════════════════════════════════════════════════════╗
║         Heuristic Residual False-Positive Rate Analysis            ║
╚════════════════════════════════════════════════════════════════════╝

📊 Global Calibration Snapshot
──────────────────────────────────────────────────────────────────────
  Router Version:        ${routerVersion}
  Total Sessions:        ${totalSessions}
  Total Comparisons:     ${totalComparisons}
  Last Updated:          ${lastUpdatedDate}

🎯 Confusion Matrix (Heuristic vs. LLM Classifier)
──────────────────────────────────────────────────────────────────────
              LLM→
            Low    Medium   High
  H┐  Low   ${matrix[0][0]?.toString().padEnd(5, " ")} ${matrix[0][1]?.toString().padEnd(5, " ")} ${matrix[0][2]?.toString().padEnd(5, " ")}
  e├ Medium ${matrix[1][0]?.toString().padEnd(5, " ")} ${matrix[1][1]?.toString().padEnd(5, " ")} ${matrix[1][2]?.toString().padEnd(5, " ")}
  u│ High   ${matrix[2][0]?.toString().padEnd(5, " ")} ${matrix[2][1]?.toString().padEnd(5, " ")} ${matrix[2][2]?.toString().padEnd(5, " ")}
  r└
  i
  s
  t
  i
  c

⚠️  False Positives (Heuristic=High, LLM≠High)
──────────────────────────────────────────────────────────────────────
  Heuristic→High, LLM→Low:      ${fpLow} (${((fpLow / totalComparisons) * 100).toFixed(2)}%)
  Heuristic→High, LLM→Medium:   ${fpMedium} (${((fpMedium / totalComparisons) * 100).toFixed(2)}%)
  ─────────────────────────────────────────────
  Total False Positives:        ${fpTotal}
  
  📈 RESIDUAL FALSE-POSITIVE RATE: ${fprPercent.toFixed(2)}%

🚦 Decision Gate for eval-layer-refinement
──────────────────────────────────────────────────────────────────────
  Threshold: >0.5%  → Implement eval layer (residual errors justify cost)
  Threshold: <0.2%  → Defer (heuristic improvements sufficient)
  Zone: 0.2–0.5%    → Re-evaluate (may depend on usage volume)

📋 Current Result:
──────────────────────────────────────────────────────────────────────
${
	fprPercent > 0.5
		? `  ✅ FPR EXCEEDS 0.5% — Ready to implement eval-layer-refinement`
		: fprPercent < 0.2
			? `  ❌ FPR BELOW 0.2% — Skip eval-layer-refinement (not cost-effective)`
			: `  ⚠️  FPR IN MARGINAL ZONE (0.2–0.5%) — Re-evaluate based on usage volume`
}

💡 Next Steps
──────────────────────────────────────────────────────────────────────
${
	fprPercent > 0.5
		? `  1. Implement confidence field in decideRouting()
  2. Add evaluation.* config block to RouterConfig
  3. Create eval-layer-refinement proposal with real data
  4. Transition from 'telemetry' to 'adaptive' mode in classifier
  → See openspec/changes/eval-layer-refinement/proposal.md for details`
		: `  No action required. Continue monitoring heuristic performance.`
}
╚════════════════════════════════════════════════════════════════════╝
`);
}

// Main
const snapshot = loadGlobalCalibration();
if (!snapshot) {
	console.error("❌ No calibration data found. Ensure telemetry has run.");
	process.exit(1);
}

analyzeFPR(snapshot);
