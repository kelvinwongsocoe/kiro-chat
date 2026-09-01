import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider";
import { runStartupChecks, describeInstall } from "./lifecycle";
import { registerParticipant } from "./participant";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Kiro Chat");

  // This build is Windows only: it looks in Windows install folders, runs
  // PowerShell, and falls back to WSL. Say so plainly rather than letting it
  // fail later as a puzzling "kiro-cli not found".
  if (process.platform !== "win32") {
    output.appendLine(`Kiro Chat is Windows only; this is ${process.platform}.`);
    vscode.window.showErrorMessage(
      "Kiro Chat only works on Windows. The panel will open but cannot start Kiro."
    );
  }

  const provider = new ChatViewProvider(context.extensionUri, output, context.globalState);

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

    vscode.commands.registerCommand("kiroChat.showUsage", () => provider.showUsage()),

    vscode.commands.registerCommand("kiroChat.showHistory", () => provider.showHistory()),

    /*
     * Opens VS Code's own chat with "@kiro " already typed.
     *
     * That box is the only one that can take a dragged file. The panel is a
     * webview, and VS Code sets pointer-events: none on every webview for as
     * long as any drag is in progress, so a drop can never land on it.
     */
    vscode.commands.registerCommand("kiroChat.askInChat", async () => {
      try {
        await vscode.commands.executeCommand("workbench.action.chat.open", {
          query: "@kiro ",
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        output.appendLine(`Could not open VS Code chat: ${message}`);
        vscode.window.showWarningMessage(
          "VS Code chat could not be opened. Open the Chat view and type @kiro."
        );
      }
    }),

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


  /*
   * Kiro in VS Code's own chat box, as `@kiro`. This is also where dragging a
   * file in works: the native chat box is ordinary workbench DOM, whereas the
   * panel is a webview, and VS Code sets pointer-events: none on every webview
   * for as long as any drag is in progress.
   *
   * Registered on its own and guarded because a chat participant is a manifest
   * contribution, so a window that was reloaded rather than restarted can
   * reject it — and that must not cost us the commands. Everything used to be
   * one subscriptions.push() whose arguments are all evaluated before the call
   * runs, so a single failure silently unregistered every command after it.
   */
  try {
    context.subscriptions.push(
      registerParticipant(context.extensionUri, provider.kiroSession, output)
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    output.appendLine(
      `Could not register the @kiro chat participant: ${message}. Close VS Code ` +
        "completely and open it again. The chat panel is unaffected."
    );
  }

  // Runs after registration so a slow check never delays the panel appearing.
  void runStartupChecks(context, output);
}

export function deactivate(): void {
  // The provider is disposed through context.subscriptions.
}
