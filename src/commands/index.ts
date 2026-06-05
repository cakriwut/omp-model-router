import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import { profileNames, ROUTER_PIN_VALUES } from "../config";
import { handleStatus } from "./status";
import { handleProfile } from "./profile";
import { handlePin } from "./pin";
import { handleThinking } from "./thinking";
import { handleDisable } from "./disable";
import { handleFix } from "./fix";
import { handleWidget } from "./widget";
import { handleDebug } from "./debug";
import { handleUsage } from "./usage";
import { handleSet } from "./set";
import { handleReload } from "./reload";
import { handleUpdate } from "./update";
import { handleHelp } from "./help";
import { handleEmbargo } from "./embargo";

export { resolveConfigValue, applyConfigUpdate, SET_KEYS } from "./shared";
export type { Actions } from "./shared";

export const registerCommands = (
	pi: ExtensionAPI,
	state: RouterState,
	actions: {
		persistState: () => void;
		updateStatus: (ctx: ExtensionContext) => void;
		reloadConfig: (
			ctx?: ExtensionContext,
			options?: { preserveDebug?: boolean },
		) => void;
		ensureValidActiveRouterProfile: (ctx: ExtensionContext) => Promise<void>;
		switchToRouterProfile: (
			profileName: string,
			ctx: ExtensionContext,
			strict?: boolean,
		) => Promise<boolean>;
	},
) => {
	// Bind handlers with state and actions
	const status = handleStatus(state, actions);
	const profile = handleProfile(state, actions);
	const pin = handlePin(state, actions);
	const thinking = handleThinking(state, actions);
	const disable = handleDisable(pi, state, actions);
	const fix = handleFix(state, actions);
	const widget = handleWidget(state, actions);
	const debug = handleDebug(state, actions);
	const usage = handleUsage(state);
	const set = handleSet(state, actions);
	const reload = handleReload(state, actions);
	const update = handleUpdate(state);
	const embargo = handleEmbargo(state);
	const help = handleHelp;

	const SUBCOMMANDS = [
		"status",
		"usage",
		"profile",
		"pin",
		"thinking",
		"disable",
		"fix",
		"widget",
		"debug",
		"set",
		"reload",
		"help",
		"update",
		"embargo",
	];

	pi.registerCommand("router", {
		description: "Model router control center",
		getArgumentCompletions: (prefix) => {
			const trimmedLeft = prefix.trimStart();
			const hasTrailingSpace = /\s$/.test(prefix);
			const parts =
				trimmedLeft.length > 0 ? trimmedLeft.split(/\s+/) : [];

			if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
				const token = parts[0] ?? "";
				const items = SUBCOMMANDS.filter((s) => s.startsWith(token)).map(
					(s) => ({ value: s, label: s }),
				);
				return items.length > 0 ? items : null;
			}

			const subcommand = parts[0];
			const subArgs = parts.slice(1);
			if (hasTrailingSpace && parts.length === 1) subArgs.push("");

			switch (subcommand) {
				case "profile": {
					const profilePrefix = subArgs[0] ?? "";
					const items = profileNames(state.currentConfig)
						.filter((name) => name.startsWith(profilePrefix))
						.map((name) => ({
							value: `profile ${name}`,
							label: `router/${name}`,
						}));
					return items.length > 0 ? items : null;
				}
				case "pin": {
					const pinPrefix = subArgs[0] ?? "";
					const items = ROUTER_PIN_VALUES.filter((v) =>
						v.startsWith(pinPrefix),
					).map((v) => ({ value: `pin ${v}`, label: v }));
					return items.length > 0 ? items : null;
				}
				case "fix": {
					const fixPrefix = subArgs[0] ?? "";
					const items = (["high", "medium", "low"] as const)
						.filter((t) => t.startsWith(fixPrefix.toLowerCase()))
						.map((t) => ({ value: `fix ${t}`, label: t }));
					return items.length > 0 ? items : null;
				}
				case "widget": {
					const wPrefix = subArgs[0] ?? "";
					const items = ["on", "off", "toggle"]
						.filter((v) => v.startsWith(wPrefix))
						.map((v) => ({ value: `widget ${v}`, label: v }));
					return items.length > 0 ? items : null;
				}
				case "debug": {
					const dPrefix = subArgs[0] ?? "";
					const items = ["on", "off", "toggle", "clear", "show"]
						.filter((v) => v.startsWith(dPrefix))
						.map((v) => ({ value: `debug ${v}`, label: v }));
					return items.length > 0 ? items : null;
				}
				case "embargo": {
					const ePrefix = subArgs[0] ?? "";
					const items = ["clear"]
						.filter((v) => v.startsWith(ePrefix))
						.map((v) => ({ value: `embargo ${v}`, label: v }));
					return items.length > 0 ? items : null;
				}
				case "set": {
					const setPrefix = subArgs[0] ?? "";
					if (!hasTrailingSpace || subArgs.length <= 1) {
					const SET_KEY_LIST = [
						"routerEnabled",
						"phaseBias",
						"budget",
						"contextThreshold",
						"debug",
						"debugVerbose",
						"debugHistoryLimit",
						"defaultProfile",
					];
						const items = SET_KEY_LIST.filter((k) => k.startsWith(setPrefix)).map(
							(k) => ({ value: `set ${k}`, label: k }),
						);
						return items.length > 0 ? items : null;
					}
					const setKey = subArgs[0];
					const valPrefix = subArgs[1] ?? "";
					if (
						setKey === "routerEnabled" ||
						setKey === "debug" ||
						setKey === "debugVerbose"
					) {
						const items = ["on", "off"]
							.filter((v) => v.startsWith(valPrefix))
							.map((v) => ({ value: `set ${setKey} ${v}`, label: v }));
						return items.length > 0 ? items : null;
					}
					if (setKey === "defaultProfile") {
						const items = profileNames(state.currentConfig)
							.filter((n) => n.startsWith(valPrefix))
							.map((n) => ({ value: `set defaultProfile ${n}`, label: n }));
						return items.length > 0 ? items : null;
					}
					return null;
				}
			}

			return null;
		},
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const subcommand = parts[0];
			const subArgs = parts.slice(1);

			switch (subcommand) {
				case "profile":
					await profile(subArgs, ctx);
					break;
				case "pin":
					await pin(subArgs, ctx);
					break;
				case "thinking":
					await thinking(subArgs, ctx);
					break;
				case "disable":
					await disable(subArgs, ctx);
					break;
				case "fix":
					await fix(subArgs, ctx);
					break;
				case "widget":
					await widget(subArgs, ctx);
					break;
				case "debug":
					await debug(subArgs, ctx);
					break;
				case "reload":
					await reload(subArgs, ctx);
					break;
				case "update":
					await update(subArgs, ctx);
					break;
				case "embargo":
					await embargo(subArgs, ctx);
					break;
				case "set":
					await set(subArgs, ctx);
					break;
				case "usage":
					await usage(subArgs, ctx);
					break;
				case "calibrate": {
					// Dynamic import: calibrate CLI is optional and heavyweight — only load when used
					const { runCalibrate } = await import("../cli/calibrate/calibrate");
					const lines: string[] = [];
					const origLog = console.log;
					const origErr = console.error;
					console.log = (msg?: unknown) => lines.push(String(msg ?? ""));
					console.error = (msg?: unknown) => lines.push(String(msg ?? ""));
					try {
						await runCalibrate(subArgs);
					} finally {
						console.log = origLog;
						console.error = origErr;
					}
					ctx.ui.notify(lines.join("\n"), "info");
					break;
				}
				case "status":
					await status(subArgs, ctx);
					break;
				case "help":
				case "?":
					await help(subArgs, ctx);
					break;
				default:
					if (subcommand) {
						if (state.currentConfig.profiles[subcommand]) {
							await actions.switchToRouterProfile(subcommand, ctx);
							ctx.ui.notify(
								`Router enabled with profile: ${state.selectedProfile}`,
								"info",
							);
						} else {
							ctx.ui.notify(
								`Unknown router subcommand: ${subcommand}. Try /router help`,
								"error",
							);
						}
					} else {
						await status(subArgs, ctx);
					}
					break;
			}
		},
	});
};
