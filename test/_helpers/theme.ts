import type { Theme } from "@oh-my-pi/pi-coding-agent";

/**
 * Minimal Theme stub for tests that exercise renderUsageReport-style helpers.
 * fg/bg/dim are identity functions so assertions can target plain text after stripAnsi.
 * Cast through unknown because the real Theme has many surface methods we don't stub —
 * test consumers only invoke fg/bg/dim.
 */
export const makeTheme = (): Theme => {
	const stub = {
		fg: (_color: string, text: string): string => text,
		bg: (_color: string, text: string): string => text,
		dim: (text: string): string => text,
	};
	return stub as unknown as Theme;
};
