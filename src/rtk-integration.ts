/**
 * RTK (Rust Token Killer) Integration
 * 
 * Delegates tool command rewrites to `rtk rewrite`, which applies token-optimized
 * filters across 100+ commands (git, cargo, ls, cat, grep, docker, aws, etc).
 * 
 * RTK reduces token consumption by 60-90% through smart filtering, grouping,
 * truncation, and deduplication.
 * 
 * See: https://github.com/rtk-ai/rtk
 */

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

type ToolCallEvent = {
	toolName: string;
	input: { command: string; [key: string]: any };
};

type RewriteDecision = 
	| { kind: "rewrite"; rewritten: string } 
	| { kind: "skip" };

/**
 * Read text from a stream (Bun runtime)
 */
function readText(stream: ReadableStream<Uint8Array> | null | undefined, name: string): Promise<string> {
	if (!stream) {
		throw new Error(`rtk rewrite ${name} stream was unavailable`);
	}
	return new Response(stream).text().then((text) => text.trim());
}

/**
 * Call `rtk rewrite <command>` to get token-optimized rewrite
 * 
 * Exit codes:
 *   0 = rewritten (stdout contains new command)
 *   3 = skip (command already optimal or not recognized)
 *   other = error (skip rewrite)
 */
async function rewriteWithRtk(command: string): Promise<RewriteDecision> {
	const proc = Bun.spawn(["rtk", "rewrite", command], {
		stdout: "pipe",
		stderr: "pipe",
	});

	const [exitCode, stdout] = await Promise.all([
		proc.exited,
		readText(proc.stdout, "stdout"),
		proc.stderr?.cancel(), // Ignore stderr
	]);

	switch (exitCode) {
		case 0: // Rewritten
		case 3: // Skip (already optimal)
			if (!stdout || stdout === command) {
				return { kind: "skip" };
			}
			return { kind: "rewrite", rewritten: stdout };
		default: // Error
			return { kind: "skip" };
	}
}

/**
 * Check if RTK binary is available in PATH
 */
function hasRtkBinary(): boolean {
	return Boolean(Bun.which("rtk"));
}

/**
 * Register RTK tool call hook
 * 
 * Intercepts bash tool calls and rewrites them via `rtk rewrite`.
 * Only activates if:
 *   1. config.enableRtk is true
 *   2. `rtk` binary is in PATH
 */
export function registerRtkIntegration(
	pi: ExtensionAPI, 
	enabled: boolean,
	debug: boolean = false,
) {
	if (!enabled) {
		return;
	}

	const hasRtk = hasRtkBinary();

	if (!hasRtk) {
		// Notify user once per session that RTK is configured but not installed
		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			ctx.ui.setStatus(
				"rtk", 
				"⚠️ RTK enabled but binary not found. Install: brew install rtk"
			);
		});
		return;
	}

	// RTK available — register tool call hook
	pi.on("tool_call", async (event: ToolCallEvent) => {
		// RTK currently only supports bash tool rewrites
		// (Other tools like read, search, edit are handled by OMP directly)
		if (event.toolName !== "bash") {
			return;
		}

		const original = event.input.command;
		if (!original || original.trim() === "") {
			return;
		}

		try {
			const decision = await rewriteWithRtk(original);
			if (decision.kind === "skip") {
				return;
			}

			// Rewrite successful
			event.input.command = decision.rewritten;

			if (debug) {
				console.log("[ROUTER] RTK rewrite:", {
					original: original.slice(0, 60),
					rewritten: decision.rewritten.slice(0, 60),
				});
			}
		} catch (error) {
			// RTK call failed — skip rewrite silently
			// (Don't want to break user's workflow if RTK has issues)
			if (debug) {
				console.error("[ROUTER] RTK rewrite failed:", error);
			}
			return;
		}
	});

	// Set status on session start
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		ctx.ui.setStatus("rtk", "✓ RTK active (60-90% token savings)");
	});
}
