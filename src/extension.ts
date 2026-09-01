import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import { runStartupChecks, describeInstall } from "./lifecycle";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Kiro Chat");
  const provider = new ChatViewProvider(context.extensionUri, output);

  context.subscriptions.push(
    output,
    provider,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("kiroChat.focus", () => provider.focus()),

    vscode.commands.registerCommand("kiroChat.newSession", () => provider.newSession()),

    vscode.commands.registerCommand("kiroChat.stop", () => provider.stop()),

    vscode.commands.registerCommand("kiroChat.restart", async () => {
      await provider.newSession();
      vscode.window.showInformationMessage("Kiro Chat: agent restarted.");
    }),

    vscode.commands.registerCommand("kiroChat.showLog", () => output.show(true)),

    vscode.commands.registerCommand("kiroChat.pickModel", () => provider.pickModel()),

    vscode.commands.registerCommand("kiroChat.showUsage", () => provider.refreshUsage()),

    // Extensions cannot place a view in the secondary sidebar themselves, but
    // VS Code lets the user move it. This just focuses the view first so the
    // built-in mover acts on the right one.
    vscode.commands.registerCommand("kiroChat.moveView", async () => {
      provider.focus();
      await new Promise((resolve) => setTimeout(resolve, 150));
      await vscode.commands.executeCommand("workbench.action.moveFocusedView");
    }),

    // Right-click in the Explorer. VS Code passes the clicked item plus the
    // whole selection when several things are highlighted.
    vscode.commands.registerCommand(
      "kiroChat.addFileToContext",
      async (clicked?: vscode.Uri, selected?: vscode.Uri[]) => {
        const uris = selected && selected.length > 0 ? selected : clicked ? [clicked] : [];
        if (uris.length === 0) {
          vscode.window.showInformationMessage("Nothing selected to add.");
          return;
        }
        await provider.addFilesFromCommand(uris);
      }
    ),

    vscode.commands.registerCommand("kiroChat.about", async () => {
      const choice = await vscode.window.showInformationMessage(
        describeInstall(context),
        { modal: true },
        "See what changed"
      );
      if (choice === "See what changed") {
        await vscode.commands.executeCommand(
          "markdown.showPreview",
          vscode.Uri.joinPath(context.extensionUri, "CHANGELOG.md")
        );
      }
    }),

    vscode.commands.registerCommand("kiroChat.explainSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      const selection = editor?.document.getText(editor.selection) ?? "";
      if (!selection.trim()) {
        vscode.window.showInformationMessage("Select some code first.");
        return;
      }
      await provider.sendFromEditor("Explain the selected code.");
    })
  );

  // Runs after registration so a slow check never delays the panel appearing.
  void runStartupChecks(context, output);
}

export function deactivate(): void {
  // The provider is disposed through context.subscriptions.
}
