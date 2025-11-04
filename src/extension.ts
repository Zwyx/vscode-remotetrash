import { exec } from "child_process";
import * as os from "os";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";

const execAsync = promisify(exec);

async function checkTrashInstalled(): Promise<boolean> {
	try {
		const { stdout, stderr } = await execAsync("which trash");
		console.log("which trash - stdout:", stdout);
		console.log("which trash - stderr:", stderr);
		return true;
	} catch (error) {
		console.log("which trash - error:", error);
		return false;
	}
}

async function deleteWithTrash(uri: vscode.Uri): Promise<void> {
	try {
		await execAsync(`trash "${uri.fsPath}"`);
	} catch (error) {
		throw new Error(
			`Failed to delete: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

// WorkspaceEdit-based approach (undoable, no dependency)
interface TrashPaths {
	filesDir: vscode.Uri;
	infoDir: vscode.Uri;
}

function getTrashPaths(): TrashPaths {
	const homeDir = os.homedir();
	const trashBase = path.join(homeDir, ".local", "share", "Trash");

	return {
		filesDir: vscode.Uri.file(path.join(trashBase, "files")),
		infoDir: vscode.Uri.file(path.join(trashBase, "info")),
	};
}

async function ensureTrashDirectories(): Promise<void> {
	const { filesDir, infoDir } = getTrashPaths();

	try {
		await vscode.workspace.fs.stat(filesDir);
	} catch {
		await vscode.workspace.fs.createDirectory(filesDir);
	}

	try {
		await vscode.workspace.fs.stat(infoDir);
	} catch {
		await vscode.workspace.fs.createDirectory(infoDir);
	}
}

function getUniqueTrashName(
	baseName: string,
	existingNames: Set<string>,
): string {
	if (!existingNames.has(baseName)) {
		return baseName;
	}

	const ext = path.extname(baseName);
	const nameWithoutExt = path.basename(baseName, ext);

	let counter = 2;
	while (true) {
		const newName = `${nameWithoutExt}.${counter}${ext}`;
		if (!existingNames.has(newName)) {
			return newName;
		}
		counter++;
	}
}

async function deleteWithWorkspaceEdit(
	uri: vscode.Uri,
	edit: vscode.WorkspaceEdit,
): Promise<void> {
	await ensureTrashDirectories();

	const { filesDir, infoDir } = getTrashPaths();
	const fileName = path.basename(uri.fsPath);

	// Get existing files in trash to handle name conflicts
	const existingFiles = await vscode.workspace.fs.readDirectory(filesDir);
	const existingNames = new Set(existingFiles.map(([name]) => name));

	// Get unique name in trash
	const trashName = getUniqueTrashName(fileName, existingNames);
	const trashFileUri = vscode.Uri.joinPath(filesDir, trashName);
	const trashInfoUri = vscode.Uri.joinPath(infoDir, `${trashName}.trashinfo`);

	// Move file to trash using WorkspaceEdit (this makes it undoable!)
	edit.renameFile(uri, trashFileUri, { overwrite: false });

	// Create trash info metadata file as part of WorkspaceEdit
	// This makes it undoable too - when you undo, both operations are reversed together!
	const deletionDate = new Date();
	const content = [
		"[Trash Info]",
		`Path=${uri.fsPath}`,
		`DeletionDate=${deletionDate.toISOString().split(".")[0]}`,
		"",
	].join("\n");

	const encoder = new TextEncoder();
	edit.createFile(trashInfoUri, {
		contents: encoder.encode(content),
		overwrite: false,
	});
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('Extension "remotetrash" is now active!');

	const disposable = vscode.commands.registerCommand(
		"remotetrash.delete",
		async (uri: vscode.Uri, uris: vscode.Uri[]) => {
			// Handle multiple selections
			let filesToDelete: vscode.Uri[];

			if (uris && uris.length > 0) {
				// Context menu with multiple selections
				filesToDelete = uris;
			} else if (uri) {
				// Context menu with single selection
				filesToDelete = [uri];
			} else {
				// Keybinding - try to get selection from explorer using clipboard trick
				try {
					await vscode.commands.executeCommand("copyFilePath");
					const clipboardContent = await vscode.env.clipboard.readText();

					if (clipboardContent) {
						// Parse the clipboard content (could be multiple paths separated by newlines)
						const paths = clipboardContent.split("\n").filter((p) => p.trim());
						filesToDelete = paths.map((p) => vscode.Uri.file(p.trim()));
					} else {
						vscode.window.showErrorMessage(
							"No files selected for deletion. Please select a file in the explorer.",
						);
						return;
					}
				} catch {
					vscode.window.showErrorMessage(
						"No files selected for deletion. Please select a file in the explorer.",
					);
					return;
				}
			}

			if (!filesToDelete || filesToDelete.length === 0) {
				vscode.window.showErrorMessage("No files selected for deletion");
				return;
			}

			const trashInstalled = await checkTrashInstalled();

			console.log(trashInstalled);

			if (!trashInstalled) {
				const response = await vscode.window.showWarningMessage(
					"trash-cli is not installed. Would you like to install it now?",
				);

				return;
			}

			// Confirm deletion
			const fileNames = filesToDelete
				.map((f) => f.fsPath.split("/").pop())
				.join(", ");
			const message =
				filesToDelete.length === 1
					? `Are you sure you want to delete '${fileNames}'?`
					: `Are you sure you want to delete ${filesToDelete.length} items?`;

			const confirm = await vscode.window.showWarningMessage(
				message,
				{ modal: true },
				"Move to Trash",
			);

			if (confirm !== "Move to Trash") {
				return;
			}

			// Delete files using WorkspaceEdit (undoable!)
			try {
				const edit = new vscode.WorkspaceEdit();

				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Moving to trash...",
						cancellable: false,
					},
					async () => {
						for (const file of filesToDelete) {
							await deleteWithWorkspaceEdit(file, edit);
						}
					},
				);

				// Apply all the edits at once (makes it a single undoable operation)
				const success = await vscode.workspace.applyEdit(edit);

				if (!success) {
					throw new Error("Failed to apply workspace edit");
				}

				// Close editors for deleted files (after the edit)
				const tabsToClose: vscode.Tab[] = [];
				for (const tabGroup of vscode.window.tabGroups.all) {
					for (const tab of tabGroup.tabs) {
						const tabUri = (tab.input as any)?.uri;
						if (
							tabUri &&
							filesToDelete.some((f) => f.toString() === tabUri.toString())
						) {
							tabsToClose.push(tab);
						}
					}
				}

				if (tabsToClose.length > 0) {
					await vscode.window.tabGroups.close(tabsToClose);
				}

				vscode.window.showInformationMessage(
					`Successfully moved ${filesToDelete.length} item(s) to trash`,
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
