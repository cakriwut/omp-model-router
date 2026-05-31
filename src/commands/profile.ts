import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { RouterProfile } from "../types";
import type { Actions } from "./shared";
import { profileNames } from "../config";
import {
	openCreateProfile,
	openRenameProfile,
	openDeleteProfile,
} from "../tui/profile-editor";

export const handleProfile = (
	state: RouterState,
	actions: Actions,
) => async (args: string[], ctx: ExtensionContext) => {
	const profileName = args[0];
	if (!profileName) {
		// Interactive TUI mode when available
		if (ctx.hasUI) {
			const profiles = profileNames(state.currentConfig);
			const labels = [
				...profiles.map((name) => `router/${name}`),
				"＋ Create new profile",
				"✎ Rename a profile",
				"✕ Delete a profile",
			];

			const onSave = async (_updatedProfiles: Record<string, RouterProfile>) => {
				await actions.reloadConfig(ctx, { preserveDebug: true });
				await actions.ensureValidActiveRouterProfile(ctx);
				ctx.ui.notify("Profile saved.", "info");
			};

			const selected = await ctx.ui.select("Select a profile or action", labels);
			if (!selected) return;

			if (selected === "＋ Create new profile") {
				await openCreateProfile(state.currentConfig, ctx.modelRegistry, ctx, onSave);
			} else if (selected === "✎ Rename a profile") {
				await openRenameProfile(state.currentConfig, ctx.modelRegistry, ctx, onSave);
			} else if (selected === "✕ Delete a profile") {
				await openDeleteProfile(state.currentConfig, ctx, onSave);
			} else if (selected.startsWith("router/")) {
				// It's a profile name - extract and switch
				const pickedName = selected.slice("router/".length);
				const success = await actions.switchToRouterProfile(pickedName, ctx);
				if (success) {
					ctx.ui.notify(
						`Switched to router profile: ${state.selectedProfile}`,
						"info",
					);
				}
			}
		} else {
			// Non-interactive fallback
			ctx.ui.notify(
				`Current profile: ${state.selectedProfile}. Available: ${profileNames(state.currentConfig).join(", ")}`,
				"info",
			);
		}
		return;
	}
	const success = await actions.switchToRouterProfile(profileName, ctx);
	if (success) {
		ctx.ui.notify(
			`Switched to router profile: ${state.selectedProfile}`,
			"info",
		);
	}
};
