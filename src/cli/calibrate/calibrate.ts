/**
 * `omp-router calibrate <subcommand>` dispatcher.
 * Pure function: takes argv tail, returns exit code, writes to stdout/stderr.
 */
import { parseTraceFiles, resolveTraceFiles } from "./parse";
import { analyzeTrace, formatAnalysisTable } from "./analyze";
import { formatSimulationTable, simulateStrategies } from "./simulate";
import { exportGlobal, importGlobal, resetGlobal } from "./state";

export async function runCalibrate(args: string[]): Promise<number> {
	const sub = args[0] ?? "help";
	const rest = args.slice(1);
	const flags = parseFlags(rest);

	try {
		switch (sub) {
			case "analyze":
				return doAnalyze(flags.positional[0]);
			case "simulate":
				return doSimulate(flags.positional[0], {
					warmup: parseInt(flags.named.warmup ?? "5", 10),
				});
			case "export":
				return doExport(flags.positional[0]);
			case "import":
				return doImport(flags.positional[0]);
			case "reset":
				return doReset();
			case "help":
			case "--help":
			case "-h":
				printHelp();
				return 0;
			default:
				console.error(`Unknown subcommand: ${sub}`);
				printHelp();
				return 1;
		}
	} catch (err) {
		console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
}

function doAnalyze(path: string | undefined): number {
	const files = resolveTraceFiles(path);
	if (files.length === 0) {
		console.error("No trace files found.");
		return 1;
	}
	const trace = parseTraceFiles(files);
	console.log(`# ${files.length} file(s), ${trace.records.length} record(s)`);
	console.log("");
	console.log(formatAnalysisTable(analyzeTrace(trace)));
	return 0;
}

function doSimulate(
	path: string | undefined,
	opts: { warmup: number },
): number {
	const files = resolveTraceFiles(path);
	const trace = parseTraceFiles(files);
	const completed = trace.records.filter((r) => r.llmDecision).length;
	if (completed < 5) {
		console.error(
			`Need at least 5 completed comparisons; found ${completed}. Collect more telemetry first.`,
		);
		return 1;
	}
	console.log(`# ${files.length} file(s), ${completed} scoreable record(s), warmup=${opts.warmup}`);
	console.log("");
	console.log(formatSimulationTable(simulateStrategies(trace, opts)));
	return 0;
}

function doExport(toPath: string | undefined): number {
	if (!toPath) {
		console.error("Usage: omp-router calibrate export <file.json>");
		return 1;
	}
	const r = exportGlobal(toPath);
	console.log(`Wrote ${r.bytes} bytes to ${r.path}`);
	return 0;
}

function doImport(fromPath: string | undefined): number {
	if (!fromPath) {
		console.error("Usage: omp-router calibrate import <file.json>");
		return 1;
	}
	const r = importGlobal(fromPath);
	console.log(
		`Imported snapshot: ${r.totalSessions} sessions, ${r.totalComparisons} comparisons`,
	);
	return 0;
}

function doReset(): number {
	const r = resetGlobal();
	if (r.existed) {
		console.log(`Removed ${r.path}`);
	} else {
		console.log("No global calibration file existed.");
	}
	return 0;
}

interface ParsedFlags {
	positional: string[];
	named: Record<string, string>;
}

function parseFlags(args: string[]): ParsedFlags {
	const positional: string[] = [];
	const named: Record<string, string> = {};
	for (const a of args) {
		if (a.startsWith("--")) {
			const eq = a.indexOf("=");
			if (eq > 0) {
				named[a.slice(2, eq)] = a.slice(eq + 1);
			} else {
				named[a.slice(2)] = "true";
			}
		} else {
			positional.push(a);
		}
	}
	return { positional, named };
}

function printHelp(): void {
	console.error("omp-router calibrate <subcommand>");
	console.error("");
	console.error("Subcommands:");
	console.error("  analyze [path]              Stats over trace JSONL");
	console.error("  simulate [path] [--warmup=N]  Compare strategies");
	console.error("  export <file.json>          Dump global snapshot");
	console.error("  import <file.json>          Restore global snapshot");
	console.error("  reset                       Delete global snapshot");
	console.error("  help                        Show this");
	console.error("");
	console.error("`path` defaults to ~/.omp/agent/model-router/traces (all *.jsonl).");
}
