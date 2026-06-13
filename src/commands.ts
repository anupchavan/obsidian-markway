import { TFile } from "obsidian";
import type MarkwayPlugin from "./main";

export function registerMarkwayCommands(plugin: MarkwayPlugin): void {
	plugin.addCommand({
		id: "doctor",
		name: "Run doctor",
		callback: () => {
			void plugin.runDoctor();
		},
	});

	plugin.addCommand({
		id: "diagnostics",
		name: "Show diagnostics",
		callback: () => {
			void plugin.showDiagnostics();
		},
	});

	plugin.addCommand({
		id: "sync-now",
		name: "Sync journal now",
		callback: () => {
			void plugin.syncVaultAndJournal({ includeNew: true, migrateFrontmatter: true });
		},
	});

	plugin.addCommand({
		id: "push-current-file",
		name: "Push current file to journal",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			const canRun = file instanceof TFile && file.extension === "md";
			if (checking) {
				return canRun;
			}
			if (canRun && file) {
				void plugin.pushFile(file, { force: true });
			}
			return true;
		},
	});

	plugin.addCommand({
		id: "pull-current-file",
		name: "Pull current file from journal",
		checkCallback: (checking) => {
			const file = plugin.app.workspace.getActiveFile();
			const canRun = file instanceof TFile && file.extension === "md";
			if (checking) {
				return canRun;
			}
			if (canRun && file) {
				void plugin.pullFile(file);
			}
			return true;
		},
	});
}
