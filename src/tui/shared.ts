import type { SelectListTheme, SymbolTheme } from "@oh-my-pi/pi-tui";
import type { Theme } from "@oh-my-pi/pi-coding-agent";

/** Build a SelectListTheme from a Theme instance (avoids relying on uninitialized module global). */
export function buildSelectListTheme(theme: Theme): SelectListTheme {
	const preset = theme.getSymbolPreset();
	const symbols: SymbolTheme = {
		cursor: theme.nav.cursor,
		inputCursor: preset === "ascii" ? "|" : "\u258f",
		boxRound: theme.boxRound,
		boxSharp: theme.boxSharp,
		table: theme.boxSharp,
		quoteBorder: theme.md.quoteBorder,
		hrChar: theme.md.hrChar,
		spinnerFrames: theme.getSpinnerFrames("activity"),
	};
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
		symbols,
	};
}
