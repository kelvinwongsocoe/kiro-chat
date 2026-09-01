import * as vscode from "vscode";
import { existsSync } from "node:fs";

const VERSION_KEY = "kiroChat.installedVersion";

/**
 * Things that should happen once, right after the extension is installed
 * or replaced with a newer build.
 */
export async function runStartupChecks(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  await repairStalePath(output);
  await announceUpgrade(context, output);
}

/**
 * If the user pinned a path to kiro-cli and that file has since moved,
 * clear it so auto-detection takes over. Kiro's own updates move the
 * binary, and a pinned path that no longer exists would otherwise look
 * like the extension is broken.
 */
async function repairStalePath(output: vscode.OutputChannel): Promise<void> {
  const config = vscode.workspace.getConfiguration("kiroChat");
  const inspected = config.inspect<string>("command");
  const saved = (inspected?.globalValue ?? "").trim();

  if (!saved) {
    return;
  }
  // A bare command name or a WSL launch is resolved elsewhere, not a file path.
  if (saved === "wsl" || !saved.includes("/") && !saved.includes("\\")) {
    return;
  }
  if (existsSync(saved)) {
    return;
  }

  output.appendLine(`Saved Kiro path no longer exists: ${saved}. Falling back to search.`);
  await config.update("command", "", vscode.ConfigurationTarget.Global);

  const choice = await vscode.window.showWarningMessage(
    "Your saved path to Kiro no longer exists, so Kiro Chat will look for it again. This usually happens after Kiro updates itself.",
    "Show log"
  );
  if (choice === "Show log") {
    output.show(true);
  }
}

/** Tell the user what changed, but only when the version actually moved. */
async function announceUpgrade(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel
): Promise<void> {
  const current = String(context.extension.packageJSON.version ?? "0.0.0");
  const previous = context.globalState.get<string>(VERSION_KEY);

  await context.globalState.update(VERSION_KEY, current);

  if (!previous) {
    output.appendLine(`Kiro Chat ${current} installed.`);
    return;
  }
  if (previous === current) {
    return;
  }

  output.appendLine(`Kiro Chat upgraded from ${previous} to ${current}. Settings kept.`);
  const choice = await vscode.window.showInformationMessage(
    `Kiro Chat updated to ${current}. Your settings were kept.`,
    "See what changed"
  );
  if (choice === "See what changed") {
    const changelog = vscode.Uri.joinPath(context.extensionUri, "CHANGELOG.md");
    await vscode.commands.executeCommand("markdown.showPreview", changelog);
  }
}

/** Backs the "About" command. */
export function describeInstall(context: vscode.ExtensionContext): string {
  const pkg = context.extension.packageJSON;
  return `Kiro Chat ${pkg.version}\n\nInstalled from a .vsix file, so VS Code will not update it on its own. To move to a newer build, install the new .vsix over this one.`;
}
