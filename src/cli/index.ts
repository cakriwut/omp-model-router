#!/usr/bin/env bun
/**
 * omp-router CLI — calibration lab harness.
 *
 * Usage:
 *   omp-router prompt-log [path] [--last N] [--json] [--prompts]
 *   omp-router calibrate analyze [path]            # analyze trace JSONL
 *   omp-router calibrate simulate [path] [--warmup=N]
 *   omp-router calibrate export <to.json>
 *   omp-router calibrate import <from.json>
 *   omp-router calibrate reset
 *   omp-router calibrate help
 *
 * `path` defaults to ~/.omp/agent/model-router/traces (all *.jsonl).
 *
 * Replay-from-session (running heuristic + classifier over historical OMP
 * sessions) is intentionally NOT in this MVP. Live telemetry already
 * produces analyzable trace JSONL; replay needs to bring up
 * modelRegistry/credentials outside an OMP runtime, which is a separate
 * effort.
 */
import { runCalibrate } from "./calibrate/calibrate";
import { runPromptLog } from "./prompt-log";
const args = process.argv.slice(2);
if (args[0] === "calibrate") {
	const code = await runCalibrate(args.slice(1));
	process.exit(code);
} else if (args[0] === "prompt-log") {
	const code = await runPromptLog(args.slice(1));
	process.exit(code);
} else if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
	printHelp();
	process.exit(0);
} else {
	console.error(`Unknown command: ${args[0]}`);
	printHelp();
	process.exit(1);
}

function printHelp(): void {
	console.error("omp-router — model router CLI");
	console.error("");
	console.error("Usage:");
	console.error("  omp-router calibrate <subcommand> [args]");
	console.error("  omp-router prompt-log [path] [--last N] [--json] [--prompts]");
	console.error("");
	console.error("Run `omp-router calibrate help` for calibration subcommands.");
	console.error("Run `omp-router prompt-log --help` for prompt log options.");
}
