import { exec } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

const execAsync = promisify(exec);

function getTrashCliPath(): string {
	const config = vscode.workspace.getConfiguration("remotetrash");
	return config.get("trashCliPath") ?? "trash";
}

async function checkTrashInstalled(trashCliPath: string): Promise<boolean> {
	try {
		await execAsync(`which ${trashCliPath}`);
		return true;
	} catch {
		const response = await vscode.window.showWarningMessage(
			`'${trashCliPath}' not found. The Remote Trash extension requires a trash CLI tool. See installation instructions.`,
			"Open Installation Instructions",
		);

		if (response === "Open Installation Instructions") {
			await vscode.commands.executeCommand(
				"extension.open",
				"zwyx.remotetrash",
			);
		}

		return false;
	}
}

async function sendToTrash(
	uri: vscode.Uri,
	trashCliPath: string,
): Promise<void> {
	try {
		await execAsync(`${trashCliPath} "${uri.fsPath}"`);
	} catch (error) {
		throw new Error(
			`Failed to delete: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

export function activate(context: vscode.ExtensionContext) {
	const disposable = vscode.commands.registerCommand(
		"remotetrash.delete",
		async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
			let filesToDelete: vscode.Uri[];

			if (uris && uris.length > 0) {
				filesToDelete = uris;
			} else if (uri) {
				filesToDelete = [uri];
			} else {
				// Keybinding - try to get selection from explorer using clipboard trick
				// https://github.com/microsoft/vscode/issues/3553#issuecomment-1098562676
				try {
					const originalClipboardContent =
						await vscode.env.clipboard.readText();

					await vscode.commands.executeCommand("copyFilePath");

					const clipboardContent = await vscode.env.clipboard.readText();

					await vscode.env.clipboard.writeText(originalClipboardContent);

					filesToDelete = clipboardContent
						.split("\n")
						.map((path) => vscode.Uri.file(path));

					if (filesToDelete.length === 0) {
						return;
					}
				} catch {
					return;
				}
			}

			const trashCliPath = getTrashCliPath();

			if (!(await checkTrashInstalled(trashCliPath))) {
				return;
			}

			try {
				// Loop through each file and try to close its tab, VS Code will ask confirmation
				// for dirty ones. Closing a tab renders other tab reference stale, so we have
				// to go through `vscode.window.tabGroups.all` for every tab
				for (const fileUri of filesToDelete) {
					let tabToClose: vscode.Tab | undefined;

					for (const tabGroup of vscode.window.tabGroups.all) {
						for (const tab of tabGroup.tabs) {
							const tabInput = tab.input;

							if (
								typeof tabInput === "object" &&
								tabInput &&
								"uri" in tabInput
							) {
								const tabUri = tabInput.uri as vscode.Uri;

								if (tabUri.toString() === fileUri.toString()) {
									tabToClose = tab;
									break;
								}
							}
						}

						if (tabToClose) {
							break;
						}
					}

					if (tabToClose) {
						const wasClosed = await vscode.window.tabGroups.close(tabToClose);

						// If user cancelled, remove file from deletion list
						if (!wasClosed) {
							filesToDelete = filesToDelete.filter(
								(f) => f.toString() !== fileUri.toString(),
							);
						}
					}
				}

				if (filesToDelete.length === 0) {
					return;
				}

				for (const file of filesToDelete) {
					await sendToTrash(file, trashCliPath);
				}

				await vscode.commands.executeCommand(
					"workbench.files.action.refreshFilesExplorer",
				);
			} catch (error) {
				vscode.window.showErrorMessage(
					error instanceof Error ? error.message : String(error),
				);
			}
		},
	);

	context.subscriptions.push(disposable);
}
