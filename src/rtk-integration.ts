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
import type { RouterState } from "./state";

type ToolCallEvent = {
	toolName: string;
	input: { command: string;[key: string]: any };
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
 * Call `rtk rewrite <command>` to get token-optimized rewrite.
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
		proc.stderr?.cancel(),
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
 * Register RTK tool call hook.
 *
 * Intercepts bash tool calls and rewrites them via `rtk rewrite`.
 * Updates `state.rtkActive` and `state.rtkRewriteCount` for observability.
 */
export function registerRtkIntegration(
	pi: ExtensionAPI,
	state: RouterState,
): void {
	const enabled = state.currentConfig.enableRtk ?? false;
	if (!enabled) {
		state.rtkActive = false;
		return;
	}

	const hasRtk = hasRtkBinary();
	if (!hasRtk) {
		state.rtkActive = false;
		// Notify on session start that RTK is configured but not installed.
		pi.on("session_start", (_event, ctx: ExtensionContext) => {
			ctx.ui.notify(
				"RTK enabled but binary not found in PATH. Install: brew install rtk",
				"warning",
			);
		});
		return;
	}

	state.rtkActive = true;

	pi.on("tool_execution_start", async (event) => {
		// RTK currently only supports bash tool rewrites.
		if (event.toolName !== "bash") return;

		const args = event.args as { command?: string };
		const original = args.command;
		if (!original || original.trim() === "") return;

		try {
			const decision = await rewriteWithRtk(original);
			if (decision.kind === "skip") return;

			args.command = decision.rewritten;
			state.rtkRewriteCount++;

			if (state.currentConfig.debug) {
				console.log(
					`[ROUTER] RTK rewrite #${state.rtkRewriteCount}: "${original.slice(0, 50)}" → "${decision.rewritten.slice(0, 50)}"`,
				);
			}
		} catch (error) {
			if (state.currentConfig.debug) {
				console.error("[ROUTER] RTK rewrite failed:", error);
			}
		}
	});
}
