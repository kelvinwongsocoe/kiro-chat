import * as vscode from "vscode";
import {
  formatUsageReport,
  KiroSession,
  parseAccountUsage,
  readUsageCommand,
} from "./kiroSession";
import {
  Attachment,
  attachmentsFromUris,
  buildBlocks,
  pickFolders,
  quickPickWorkspaceFiles,
  readSelection,
  SelectionContext,
} from "./context";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewId = "kiroChat.view";

  private view: vscode.WebviewView | undefined;
  private readonly session: KiroSession;
  private readonly watchers: vscode.Disposable[] = [];
  private attachments: Attachment[] = [];
  private everConnected = false;
  private selection: SelectionContext | undefined;
  private selectionTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel
  ) {
    this.session = new KiroSession(output, {
      onStatus: (status, detail) => this.post({ type: "status", status, detail }),
      onText: (text) => this.post({ type: "chunk", text }),
      onThought: (text) => this.post({ type: "thought", text }),
      onTool: (tool) => this.post({ type: "tool", tool }),
      onTurnEnd: (reason) => this.post({ type: "turnEnd", reason }),
      onError: (message) => this.post({ type: "error", text: message }),
      onNeedsSetup: (reason) => this.post({ type: "needsSetup", reason }),
      onModels: (models, currentModelId) =>
        this.post({ type: "models", models, currentModelId }),
      onUsage: (usage) => this.post({ type: "usage", usage }),
      onCapabilities: (caps) => this.post({ type: "capabilities", caps }),
    });

    // Track where the user is working, so the chip stays current.
    this.watchers.push(
      vscode.window.onDidChangeTextEditorSelection(() => this.refreshSelection()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshSelection())
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage(async (message) => {
      switch (message?.type) {
        case "ready":
          await this.onWebviewReady(Boolean(message.restored));
          break;
        case "send":
          await this.send(String(message.text ?? ""), Boolean(message.includeSelection));
          break;
        case "stop":
          this.session.cancel();
          break;
        case "new":
          await this.newSession();
          break;
        case "attachFiles":
          await this.addAttachments(await quickPickWorkspaceFiles());
          break;
        case "attachFolders":
          await this.addAttachments(await pickFolders());
          break;
        case "attachImage":
          await this.attachImageFromDisk();
          break;
        case "pastedImage":
          this.addImageAttachment(
            String(message.name ?? "pasted image"),
            String(message.data ?? ""),
            String(message.mimeType ?? "image/png")
          );
          break;
        case "dropped":
          await this.handleDrop(Array.isArray(message.uris) ? message.uris : []);
          break;
        case "removeAttachment":
          this.attachments = this.attachments.filter((a) => a.id !== message.id);
          this.postAttachments();
          break;
        case "clearAttachments":
          this.attachments = [];
          this.postAttachments();
          break;
        case "setModel":
          await this.changeModel(String(message.modelId ?? ""));
          break;
        case "refreshUsage":
          await this.refreshUsage();
          break;
        case "openFile":
          await this.openPath(String(message.path ?? ""));
          break;
        case "installKiro":
          this.runInTerminal(this.installCommand());
          break;
        case "signIn":
          this.runInTerminal("kiro-cli login");
          break;
        case "retry":
          this.post({ type: "cleared" });
          await this.session.newSession().catch(() => undefined);
          break;
        case "openSettings":
          void vscode.commands.executeCommand("workbench.action.openSettings", "kiroChat");
          break;
        case "showLog":
          this.output.show(true);
          break;
      }
    });

    view.onDidDispose(() => {
      this.view = undefined;
    });
  }

  /**
   * The webview just loaded. That happens on first open and again every time
   * the view is dragged to another part of the window, which throws away the
   * page. If it restored a transcript we leave the session alone; if it came
   * up blank we hand the user a fresh chat, connected and ready.
   */
  private async onWebviewReady(restored: boolean): Promise<void> {
    this.refreshSelection(true);
    this.postAttachments();

    const state = this.session.getModels();
    if (state.models.length > 0) {
      this.post({ type: "models", models: state.models, currentModelId: state.currentModelId });
    }
    this.post({ type: "capabilities", caps: { image: this.session.canSendImages } });
    this.post({ type: "status", status: this.session.currentStatus });

    if (restored) {
      const usage = this.session.getUsage();
      if (Object.keys(usage).length > 0) {
        this.post({ type: "usage", usage });
      }
      void this.session.ensureReady().catch(() => undefined);
      return;
    }

    // Blank panel. Make Kiro's memory match what the user is looking at.
    this.attachments = [];
    this.postAttachments();
    try {
      if (this.everConnected) {
        await this.session.newSession();
      } else {
        await this.session.ensureReady();
      }
      this.everConnected = true;
    } catch {
      // The setup screen already explains what to do.
    }
  }

  private post(message: unknown): void {
    void this.view?.webview.postMessage(message);
  }

  focus(): void {
    void vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
  }

  // ---- selection chip -------------------------------------------------

  /** Debounced: selection changes fire on every cursor move. */
  private refreshSelection(immediate = false): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    const run = () => {
      this.selection = readSelection();
      this.post({
        type: "selection",
        selection: this.selection
          ? {
              relativePath: this.selection.relativePath,
              startLine: this.selection.startLine,
              endLine: this.selection.endLine,
              hasSelection: this.selection.hasSelection,
              lineCount: this.selection.endLine - this.selection.startLine + 1,
            }
          : undefined,
      });
    };
    if (immediate) {
      run();
    } else {
      this.selectionTimer = setTimeout(run, 150);
    }
  }

  // ---- attachments ----------------------------------------------------

  private async addAttachments(added: Attachment[]): Promise<void> {
    if (added.length === 0) return;
    for (const item of added) {
      if (!this.attachments.some((a) => a.id === item.id)) {
        this.attachments.push(item);
      }
    }
    this.postAttachments();
  }

  private addImageAttachment(name: string, data: string, mimeType: string): void {
    if (!data) return;
    if (!this.session.canSendImages) {
      vscode.window.showWarningMessage(
        "This version of Kiro does not accept images in chat."
      );
      return;
    }
    this.attachments.push({
      id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "image",
      label: name,
      data,
      mimeType,
    });
    this.postAttachments();
  }

  private async attachImageFromDisk(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      openLabel: "Attach image",
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
    });
    for (const uri of uris ?? []) {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const ext = uri.path.split(".").pop()?.toLowerCase() ?? "png";
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      this.addImageAttachment(
        uri.path.split("/").pop() ?? "image",
        Buffer.from(bytes).toString("base64"),
        mime
      );
    }
  }

  private async handleDrop(rawUris: unknown[]): Promise<void> {
    const uris: vscode.Uri[] = [];
    for (const raw of rawUris) {
      const text = String(raw ?? "").trim();
      if (!text) continue;
      try {
        uris.push(text.startsWith("file:") ? vscode.Uri.parse(text) : vscode.Uri.file(text));
      } catch {
        // Not a path we can use.
      }
    }
    const added = await attachmentsFromUris(uris);
    await this.addAttachments(added);
    if (added.length > 0) {
      this.post({ type: "insertMentions", labels: added.map((a) => a.label) });
    }
  }

  private postAttachments(): void {
    this.post({
      type: "attachments",
      attachments: this.attachments.map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        path: a.path,
      })),
    });
  }

  private async openPath(fsPath: string): Promise<void> {
    if (!fsPath) return;
    try {
      const uri = vscode.Uri.file(fsPath);
      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) !== 0) {
        await vscode.commands.executeCommand("revealInExplorer", uri);
      } else {
        await vscode.window.showTextDocument(uri, { preview: true });
      }
    } catch {
      vscode.window.showWarningMessage("That file could not be opened.");
    }
  }

  // ---- sending --------------------------------------------------------

  async send(text: string, includeSelection: boolean): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && this.attachments.length === 0) return;

    this.selection = readSelection();
    const attached = [...this.attachments];

    this.post({
      type: "userMessage",
      text: trimmed,
      attachments: attached.map((a) => ({ kind: a.kind, label: a.label })),
      selection:
        includeSelection && this.selection?.hasSelection
          ? `${this.selection.relativePath}:${this.selection.startLine}-${this.selection.endLine}`
          : undefined,
    });

    const blocks = buildBlocks(trimmed, attached, this.selection, includeSelection);

    this.attachments = [];
    this.postAttachments();

    this.everConnected = true;
    await this.session.send(blocks);
  }

  async sendFromEditor(text: string): Promise<void> {
    this.focus();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await this.send(text, true);
  }

  stop(): void {
    this.session.cancel();
  }

  async newSession(): Promise<void> {
    this.attachments = [];
    this.post({ type: "cleared" });
    this.postAttachments();
    await this.session.newSession();
  }

  async addFilesFromCommand(uris: vscode.Uri[]): Promise<void> {
    this.focus();
    await this.addAttachments(await attachmentsFromUris(uris));
  }

  dispose(): void {
    if (this.selectionTimer) clearTimeout(this.selectionTimer);
    for (const w of this.watchers) w.dispose();
    this.session.dispose();
  }

  // ---- models and usage ------------------------------------------------

  async changeModel(modelId: string): Promise<void> {
    if (!modelId) return;
    try {
      await this.session.setModel(modelId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showWarningMessage(`Could not switch model: ${message}`);
      const state = this.session.getModels();
      this.post({ type: "models", models: state.models, currentModelId: state.currentModelId });
    }
  }

  async pickModel(): Promise<void> {
    const { models, currentModelId } = this.session.getModels();
    if (models.length === 0) {
      vscode.window.showInformationMessage(
        "No models to choose from yet. Open the Kiro chat panel first so it can connect."
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(
      models.map((m) => ({
        label: m.name,
        description:
          [
            m.modelId === currentModelId ? "current" : "",
            m.creditRate ? `${m.creditRate} credits` : "",
            m.contextWindow ?? "",
          ]
            .filter(Boolean)
            .join("  ·  ") || undefined,
        detail: m.description,
        modelId: m.modelId,
      })),
      { title: "Pick a model for Kiro", placeHolder: "Which model should Kiro use?" }
    );
    if (picked) await this.changeModel(picked.modelId);
  }

  /**
   * Ask Kiro's own /usage command for the account picture. ACP only reports
   * this session's context and credits, so the command is the only way to see
   * the plan cap and reset date.
   */
  async refreshUsage(): Promise<void> {
    this.post({ type: "usageReportLoading" });
    try {
      const result = await this.session.runCommand("usage");
      this.output.appendLine(
        `usage answered: ${JSON.stringify(result.data ?? result.text)}`
      );

      // Kiro answers with structured data. Older builds only print prose, so
      // fall back to reading that rather than showing nothing.
      const account = result.data
        ? readUsageCommand(result.data)
        : parseAccountUsage(result.text);

      // What we can read goes onto the strip and under the model list, so the
      // numbers stay visible once this card has scrolled by.
      if (Object.keys(account).length > 0) {
        this.post({ type: "usage", usage: this.session.mergeUsage(account) });
      } else {
        this.output.appendLine("No plan credit figures found in the usage answer.");
      }

      const report = formatUsageReport(result.data, result.text);
      if (!report) {
        this.post({
          type: "usageReport",
          ok: false,
          text: "Kiro answered the usage command with nothing at all.",
        });
        return;
      }

      this.post({ type: "usageReport", text: report, ok: result.ok });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`usage failed: ${message}`);
      this.post({
        type: "usageReport",
        ok: false,
        text:
          `Kiro would not report account usage: ${message}\n\n` +
          "Run `kiro-cli` in a terminal and type `/usage` to see your plan's credit total " +
          "and reset date. Kiro Chat: Show Log has the full exchange.",
      });
    }
  }

  // ---- setup helpers ---------------------------------------------------

  private installCommand(): string {
    return "irm 'https://cli.kiro.dev/install.ps1' | iex";
  }

  private runInTerminal(command: string): void {
    const terminal = vscode.window.createTerminal({
      name: "Kiro setup",
      shellPath: "powershell.exe",
    });
    terminal.show();
    terminal.sendText(command, false);
  }

  private html(webview: vscode.Webview): string {
    const media = (file: string) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", file));
    const n = nonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${n}'; img-src ${webview.cspSource} data:;" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="stylesheet" href="${media("chat.css")}" />
<title>Kiro Chat</title>
</head>
<body>
  <div class="topbar">
    <div id="status" class="status" data-state="stopped">Not connected</div>
    <button type="button" id="usage-btn" class="linkish" title="Show credits and context used">Usage</button>
  </div>

  <div id="usage-bar" class="usage-bar" hidden>
    <div class="usage-track"><div id="usage-fill" class="usage-fill"></div></div>
    <span id="usage-text" class="usage-text"></span>
  </div>

  <div id="messages" class="messages" role="log" aria-live="polite">
    <div class="empty">
      <p>Ask Kiro about your code.</p>
      <p class="hint">Drop files on the box below, paste a screenshot, or just start typing.</p>
    </div>
  </div>

  <div id="dropzone" class="dropzone" hidden><span>Drop to add as context</span></div>

  <form id="composer" class="composer">
    <div id="chips" class="chips" hidden></div>

    <textarea id="input" rows="2" placeholder="Ask Kiro&#8230;  (Enter to send, Shift+Enter for a new line)"></textarea>

    <div class="composer-row">
      <div class="attach-wrap">
        <button type="button" id="attach" class="icon" title="Attach files, folders or an image" aria-haspopup="true" aria-expanded="false">+</button>
        <div id="attach-menu" class="popup" hidden>
          <button type="button" data-act="attachFiles">Files from this project</button>
          <button type="button" data-act="attachFolders">A folder</button>
          <button type="button" data-act="attachImage">An image</button>
        </div>
      </div>
      <div class="model-wrap">
        <button type="button" id="model-btn" class="model-btn" aria-haspopup="listbox" aria-expanded="false" disabled>
          <span id="model-label">Default model</span>
          <span class="caret">&#9662;</span>
        </button>
        <div id="model-menu" class="model-menu" hidden role="listbox"></div>
      </div>
      <span class="spacer"></span>
      <button type="button" id="stop" class="ghost" hidden>Stop</button>
      <button type="submit" id="send">Send</button>
    </div>
  </form>

  <script nonce="${n}" src="${media("chat.js")}"></script>
</body>
</html>`;
  }
}
