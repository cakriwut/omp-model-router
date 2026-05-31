import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { Actions } from "./shared";
import { profileNames } from "../config";
import {
	openCreateProfile,
	openRenameProfile,
	openDeleteProfile,
	openProfileEditor,
} from "../tui/profile-editor";

export const handleProfile = (
	state: RouterState,
	actions: Actions,
) => async (args: string[], ctx: ExtensionContext) => {
	const profileName = args[0];
	if (!profileName) {
		// Interactive TUI mode when available
		if (ctx.hasUI) {
			// Import ProfileListComponent
			const { ProfileListComponent } = await import("../tui/profile-list");

			// Build profile entries
			const profiles = profileNames(state.currentConfig).map((name) => ({
				name,
				profile: state.currentConfig.profiles[name],
			}));

			const onSave = async () => {
				await actions.reloadConfig(ctx, { preserveDebug: true });
				await actions.ensureValidActiveRouterProfile(ctx);
				ctx.ui.notify("Profile saved.", "info");
			};

			// Don't await — return immediately so loading animation stops
			ctx.ui.custom<any>((tui, theme, keybindings, done) => {
				const component = new ProfileListComponent(
					tui,
					theme,
					keybindings,
					(result) => {
						done(result);
						if (!result) return;

						// Handle result
						switch (result.action) {
							case "activate": {
								actions.switchToRouterProfile(result.profile, ctx).then((success) => {
									if (success) {
										ctx.ui.notify(
											`Switched to router profile: ${state.selectedProfile}`,
											"info",
										);
									}
								});
								break;
							}
							case "edit": {
								openProfileEditor(
									result.profile,
									state.currentConfig,
									ctx.modelRegistry,
									ctx,
									onSave,
								);
								break;
							}
							case "create": {
								openCreateProfile(state.currentConfig, ctx.modelRegistry, ctx, onSave);
								break;
							}
							case "rename": {
								openRenameProfile(state.currentConfig, ctx.modelRegistry, ctx, onSave);
								break;
							}
							case "delete": {
								openDeleteProfile(state.currentConfig, ctx, onSave);
								break;
							}
						}
					},
					profiles,
					state.selectedProfile,
				);
				tui.requestRender();
				return component;
			});
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
