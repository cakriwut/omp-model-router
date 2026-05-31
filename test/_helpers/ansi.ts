export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
