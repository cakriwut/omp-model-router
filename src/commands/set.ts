import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getAgentDir } from "@oh-my-pi/pi-coding-agent";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RouterState } from "../state";
import { applyConfigUpdate, resolveConfigValue, type Actions } from "./shared";

export const handleSet = (
	_state: RouterState,
	actions: Actions,
) => async (args: string[], ctx: ExtensionContext) => {
	if (args.length === 0) {
		const lines = [
			"Usage: /router set <key> [value]",
			"",
			"Global keys:",
			"  routerEnabled <on|off>         Enable/disable the router across sessions",
			"  phaseBias <float>              Phase bias weight (0-1)",
			"  budget <float>                 Max session budget ($)",
			"  contextThreshold <int>         Large context threshold (tokens)",
			"  debug <on|off>                 Debug mode (console logging)",
			"  debugVerbose <on|off>          Verbose debug (session JSONL logging)",
			"  debugHistoryLimit <int>        Max routing decisions to keep (default: 12)",
			"  defaultProfile <name>          Default profile name",
			"  compression <on|off>           Enable/disable TOON compression",
			"  compression.keepLastN <int>    Messages to keep uncompressed",
			"",
			"Profile keys (dot-path):",
			"  <profile>.<tier>.model <ref>         Primary model",
			"  <profile>.<tier>.thinking <level>    Thinking level",
			"  <profile>.<tier>.fallbacks <m1,m2>   Fallback models (comma-separated)",
			"",
			"Omit value to show current setting.",
		];
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	const key = args[0];
	const value = args.slice(1).join(" ");

	const globalPath = join(getAgentDir(), "model-router.json");
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(readFileSync(globalPath, "utf-8"));
	} catch {
		ctx.ui.notify("Failed to read config file", "error");
		return;
	}

	// Show current value when no value provided
	if (!value) {
		const current = resolveConfigValue(raw, key);
		ctx.ui.notify(
			`${key} = ${current === undefined ? "(unset)" : JSON.stringify(current)}`,
			"info",
		);
		return;
	}

	// Apply the update
	const error = applyConfigUpdate(raw, key, value);
	if (error) {
		ctx.ui.notify(error, "error");
		return;
	}

	// Write back
	try {
		writeFileSync(globalPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
	} catch (e) {
		ctx.ui.notify(`Failed to write config: ${e}`, "error");
		return;
	}

	// Reload
	actions.reloadConfig(ctx, { preserveDebug: true });
	await actions.ensureValidActiveRouterProfile(ctx);

	const newValue = resolveConfigValue(raw, key);
	ctx.ui.notify(
		`Set ${key} = ${JSON.stringify(newValue)}  (config reloaded)`,
		"info",
	);
};
