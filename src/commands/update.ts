import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { RouterState } from "../state";
import { isDevInstall, getCurrentVersion, checkForUpdate } from "../version-check";
import { detectCLI } from "../cli-detect";

export const handleUpdate = (
	state: RouterState,
) => async (_args: string[], ctx: ExtensionContext) => {
	// Detect which CLI we're running under
	const cliBinary = detectCLI();
	
	// Block dev installs from attempting npm updates
	if (isDevInstall()) {
		ctx.ui.notify(
			[
				"Update unavailable: dev install detected.",
				"",
				"This extension is installed via local file path or symlink.",
				"To enable updates, reinstall from npm:",
				"",
				`  cd ~/.omp/agent/extensions/model-router`,
				`  bun add @cakriwut/omp-model-router`,
				"",
				`Or reinstall via ${cliBinary} CLI:`,
				`  ${cliBinary} uninstall model-router`,
				`  ${cliBinary} install npm:@cakriwut/omp-model-router`,
			].join("\n"),
			"info",
		);
		return;
	}

	const currentVersion = getCurrentVersion();

	// If we already know about an update from the session check, use that
	if (state.updateAvailable) {
		const { current, latest } = state.updateAvailable;
		const confirmed = await ctx.ui.confirm(
			"Model Router Update",
			`Update Model Router v${current} → v${latest}?`,
		);

		if (!confirmed) {
			ctx.ui.notify("Update cancelled.", "info");
			return;
		}

		ctx.ui.notify("Updating…", "info");

		try {
			const proc = Bun.spawn(
				[cliBinary, "update", "npm:@cakriwut/omp-model-router"],
				{ stdout: "pipe", stderr: "pipe" },
			);

			const exitCode = await proc.exited;

			if (exitCode === 0) {
				ctx.ui.notify(
					`Updated to v${latest}. Restart session to use new version.`,
					"info",
				);
				state.updateAvailable = undefined;
			} else {
				const stderr = await new Response(proc.stderr).text();
				ctx.ui.notify(
					`Update failed (exit ${exitCode}): ${stderr.slice(0, 200)}`,
					"error",
				);
			}
		} catch (err) {
			ctx.ui.notify(
				`Update failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}

		return;
	}

	// No cached update info — run a fresh check
	ctx.ui.notify("Checking for updates…", "info");

	const info = await checkForUpdate();

	if (info) {
		state.updateAvailable = { current: info.current, latest: info.latest };

		const confirmed = await ctx.ui.confirm(
			"Model Router Update",
			`Update Model Router v${info.current} → v${info.latest}?`,
		);

		if (!confirmed) {
			ctx.ui.notify("Update cancelled.", "info");
			return;
		}

		ctx.ui.notify("Updating…", "info");

		try {
			const proc = Bun.spawn(
				[cliBinary, "update", "npm:@cakriwut/omp-model-router"],
				{ stdout: "pipe", stderr: "pipe" },
			);

			const exitCode = await proc.exited;

			if (exitCode === 0) {
				ctx.ui.notify(
					`Updated to v${latest}. Restart session to use new version.`,
					"info",
				);
				state.updateAvailable = undefined;
			} else {
				const stderr = await new Response(proc.stderr).text();
				ctx.ui.notify(
					`Update failed (exit ${exitCode}): ${stderr.slice(0, 200)}`,
					"error",
				);
			}
		} catch (err) {
			ctx.ui.notify(
				`Update failed: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	} else {
		ctx.ui.notify(`Model Router v${currentVersion} is up to date.`, "info");
	}
};
