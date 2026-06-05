import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export type Actions = {
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
};

export const SET_KEYS = [
	"routerEnabled",
	"phaseBias",
	"budget",
	"contextThreshold",
	"debug",
	"defaultProfile",
] as const;

export const resolveConfigValue = (
	raw: Record<string, unknown>,
	key: string,
): unknown => {
	// Profile dot-path: <profile>.<tier>.model|thinking|fallbacks
	const profileMatch = key.match(/^([^.]+)\.(high|medium|low)\.(model|thinking|fallbacks)$/);
	if (profileMatch) {
		const [, profile, tier, field] = profileMatch;
		const profiles = raw.profiles as Record<string, Record<string, Record<string, unknown>>> | undefined;
		return profiles?.[profile]?.[tier]?.[field];
	}
	switch (key) {
		case "routerEnabled":       return raw.routerEnabled;
		case "phaseBias":           return raw.phaseBias;
		case "budget":              return raw.maxSessionBudget;
		case "contextThreshold":    return raw.largeContextThreshold;
		case "debug":               return raw.debug;
		case "defaultProfile":      return raw.defaultProfile;
		default:                    return undefined;
	}
};

export const applyConfigUpdate = (
	raw: Record<string, unknown>,
	key: string,
	value: string,
): string | null => {
	// Profile dot-path: <profile>.<tier>.model|thinking|fallbacks
	const profileMatch = key.match(/^([^.]+)\.(high|medium|low)\.(model|thinking|fallbacks)$/);
	if (profileMatch) {
		const [, profile, tier, field] = profileMatch;
		const profiles = raw.profiles as Record<string, Record<string, Record<string, unknown>>> | undefined;
		if (!profiles?.[profile]) return `Unknown profile: "${profile}"`;
		if (!profiles[profile][tier]) return `Unknown tier: "${tier}"`;
		if (field === "fallbacks") {
			profiles[profile][tier].fallbacks = value.split(",").map((s) => s.trim()).filter(Boolean);
		} else {
			profiles[profile][tier][field] = value;
		}
		return null;
	}

	switch (key) {
		case "routerEnabled": {
			if (value !== "on" && value !== "off") return 'routerEnabled must be "on" or "off"';
			raw.routerEnabled = value === "on";
			return null;
		}
		case "phaseBias": {
			const n = parseFloat(value);
			if (isNaN(n) || n < 0 || n > 1) return "phaseBias must be a float between 0 and 1";
			raw.phaseBias = n;
			return null;
		}
		case "budget": {
			const n = parseFloat(value);
			if (isNaN(n) || n < 0) return "budget must be a non-negative number";
			raw.maxSessionBudget = n;
			return null;
		}
		case "contextThreshold": {
			const n = parseInt(value, 10);
			if (isNaN(n) || n < 0) return "contextThreshold must be a non-negative integer";
			raw.largeContextThreshold = n;
			return null;
		}
		case "debug": {
			if (value !== "on" && value !== "off") return 'debug must be "on" or "off"';
			raw.debug = value === "on";
			return null;
		}
		case "defaultProfile": {
			const profiles = raw.profiles as Record<string, unknown> | undefined;
			if (!profiles?.[value]) return `Unknown profile: "${value}"`;
			raw.defaultProfile = value;
			return null;
		}
		default:
			return `Unknown key: "${key}". Run /router set for available keys.`;
	}
};
