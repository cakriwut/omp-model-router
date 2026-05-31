import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const handleHelp = async (
	_args: string[],
	ctx: ExtensionContext,
) => {
	ctx.ui.notify(
		[
			"Router Subcommands:",
			"  status                      Show current status, profile, pin, cost, and last decision.",
			"  usage                       Show model context, cost, and session usage summary.",
			"  profile [name]              Switch to a profile (enables router if off). Lists available if no name.",
			"  pin [profile] <tier|auto>   Force a tier (high|medium|low) for a profile or set to auto.",
			"  thinking [prof] [tier] <lv> Override thinking level for a profile/tier (off|minimal|...|xhigh|auto).",
			"  disable                     Disable the router and restore the last used non-router model.",
			"  fix <tier>                  Correct the last routing decision and pin that tier for the current profile.",
			"  widget <on|off|toggle>      Control the persistent status widget visibility.",
			"  debug <on|off|show|clear>   Control routing debug logging to notifications and history.",
			"  reload                      Hot-reload the configuration JSON from .omp/model-router.json.",
			"  set <key> [value]            Get or set config value (writes to model-router.json). Omit value to read.",
			"  calibrate <sub>              Calibration lab harness (analyze | simulate | export | import | reset).",
			"  help, ?                     Show this help message.",
			"  update                      Check for and apply extension updates from npm.",
		].join("\n"),
		"info",
	);
};
