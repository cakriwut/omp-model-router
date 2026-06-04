import type { Theme } from "@oh-my-pi/pi-coding-agent";

/**
 * Minimal Theme stub for tests that exercise renderUsageReport-style helpers.
 * fg/bg/dim/bold are identity functions so assertions can target plain text after stripAnsi.
 * Cast through unknown because the real Theme has many surface methods we don't stub —
 * test consumers only invoke the subset they exercise.
 */
export const makeTheme = (): Theme => {
	const stub = {
		fg: (_color: string, text: string): string => text,
		bg: (_color: string, text: string): string => text,
		dim: (text: string): string => text,
		bold: (text: string): string => text,
		italic: (text: string): string => text,
		underline: (text: string): string => text,
		strikethrough: (text: string): string => text,
		inverse: (text: string): string => text,
		getSymbolPreset: (): string => "unicode",
		nav: { cursor: "❯", selected: "●", expand: "▸", collapse: "▾", back: "◂" },
		boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
		boxSharp: { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│", cross: "┼", teeDown: "┬", teeUp: "┴", teeRight: "├", teeLeft: "┤" },
		md: { quoteBorder: "│", hrChar: "─", bullet: "•" },
		getSpinnerFrames: (): string[] => ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
	};
	return stub as unknown as Theme;
};
