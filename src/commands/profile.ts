import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import type { Actions } from "./shared";
import { patchConfigFile, profileNames } from "../config";
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
			// Import ProfileListComponent
			const { ProfileListComponent } = await import("../tui/profile-list");

			// Build profile entries
			const profiles = profileNames(state.currentConfig).map((name) => ({
				name,
				profile: state.currentConfig.profiles[name],
			}));

			const onReload = async () => {
				await actions.reloadConfig(ctx, { preserveDebug: true });
				await actions.ensureValidActiveRouterProfile(ctx);
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
								// Legacy fallback — should not be hit when inlineOptions are provided
								break;
							}
							case "create": {
								openCreateProfile(state.currentConfig, ctx.modelRegistry, ctx, async () => {
									await onReload();
									ctx.ui.notify("Profile saved.", "info");
								});
								break;
							}
							case "rename": {
								openRenameProfile(state.currentConfig, ctx.modelRegistry, ctx, async () => {
									await onReload();
									ctx.ui.notify("Profile renamed.", "info");
								});
								break;
							}
							case "delete": {
								openDeleteProfile(state.currentConfig, ctx, async () => {
									await onReload();
									ctx.ui.notify("Profile deleted.", "info");
								});
								break;
							}
						}
					},
					profiles,
					state.selectedProfile,
					// Inline options: enable edit sub-view navigation
					{
						config: state.currentConfig,
						modelRegistry: ctx.modelRegistry,
						onSave: (savedProfileName, profile) => {
							// Persist and reload config
							patchConfigFile({ profiles: { ...state.currentConfig.profiles, [savedProfileName]: profile } });
							onReload().then(() => ctx.ui.notify("Profile saved.", "info"));
						},
						onCalibrationSave: (calibration) => {
							patchConfigFile({ calibration });
							onReload().then(() => ctx.ui.notify("Classifier settings saved.", "info"));
						},
					},
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
