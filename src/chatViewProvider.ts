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
import { ActiveFile, attachmentsForMessage } from "./activeFile";
import { parseDroppedPaths } from "./dropped";
import { findKiro } from "./findKiro";
import { SetupWatcher } from "./setupWatcher";
import {
  ChatRecord,
  forWorkspace,
  groupByDay,
  HistoryItem,
  pruneHistory,
  titleFrom,
  upsertRecord,
} from "./history";
import { applyChatMode, chatMode } from "./chatModes";

/** Past chats are kept here, across windows and restarts. */
const HISTORY_KEY = "kiroChat.history";
/** Enough to be useful without turning globalState into a database. */
const MAX_CHATS = 100;
/**
 * Images are handed to the webview as data URIs so they can be previewed.
 * Past this size the chip stays as text rather than pushing megabytes through
 * postMessage for something rendered 40 pixels wide.
 */
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;

function freshId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

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
  private readonly pendingPermissions = new Map<
    string,
    (optionId: string | undefined) => void
  >();

  /** Watches for Kiro appearing and connects, so the user need not click. */
  private readonly setup: SetupWatcher;
  /**
   * True while the setup screen owns the panel. Every failed connection
   * attempt makes the session fire onNeedsSetup again; without this the
   * watcher's own progress would be wiped by a fresh setup screen each time.
   */
  private setupActive = false;

  /** Our id for the chat on screen, so saving it again replaces it. */
  private chatId = freshId();
  /** The transcript, as the webview reports it after each turn. */
  private transcript: HistoryItem[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
    private readonly store: vscode.Memento
  ) {
    this.setup = new SetupWatcher({
      probe: async () => {
        const found = await findKiro(() => undefined);
        if (!found) return undefined;
        return found.source === "WSL" ? "inside WSL" : found.command;
      },
      connect: () => this.session.ensureReady(),
      onState: (state, detail) => this.onSetupState(state, detail),
    });

    this.session = new KiroSession(output, {
      onStatus: (status, detail) => this.post({ type: "status", status, detail }),
      onText: (text) => this.post({ type: "chunk", text }),
      onThought: (text) => this.post({ type: "thought", text }),
      onTool: (tool) => this.post({ type: "tool", tool }),
      onTurnEnd: (reason) => this.post({ type: "turnEnd", reason }),
      onError: (message) => this.post({ type: "error", text: message }),
      onNeedsSetup: (reason) => this.onNeedsSetup(reason),
      onModels: (models, currentModelId) =>
        this.post({ type: "models", models, currentModelId }),
      onUsage: (usage) => this.post({ type: "usage", usage }),
      onCapabilities: (caps) => this.post({ type: "capabilities", caps }),
      onPermission: (request) => this.requestPermissionInChat(request),
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
          await this.send(
            String(message.text ?? ""),
            Boolean(message.includeSelection),
            message.includeActiveFile !== false,
            message.mode
          );
          break;
        case "stop":
          this.cancelPendingPermissions();
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
          await this.handleDrop(
            Array.isArray(message.values) ? message.values : [],
            Array.isArray(message.types) ? message.types : [],
            Number(message.fileCount ?? 0)
          );
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
          // The terminal is the user's to drive, but the panel can watch for
          // the binary landing and take it from there.
          this.setup.start();
          break;
        case "signIn":
          this.runInTerminal("kiro-cli login");
          this.setup.signIn();
          break;
        case "copyCommand":
          await vscode.env.clipboard.writeText(this.installCommand());
          vscode.window.showInformationMessage(
            "Install command copied. Paste it into any PowerShell window."
          );
          break;
        case "retry":
          this.setup.stop();
          this.setupActive = false;
          this.post({ type: "cleared" });
          await this.session.newSession().catch(() => undefined);
          break;
        case "openSettings":
          void vscode.commands.executeCommand("workbench.action.openSettings", "kiroChat");
          break;
        case "showLog":
          this.output.show(true);
          break;
        case "permissionDecision": {
          const requestId = String(message.requestId ?? "");
          const resolve = this.pendingPermissions.get(requestId);
          if (!resolve) break;
          this.pendingPermissions.delete(requestId);
          resolve(message.optionId === undefined ? undefined : String(message.optionId));
          break;
        }
        case "transcript":
          // The webview keeps the transcript already; this is it reporting in
          // after a turn so the same copy can outlive the panel.
          this.transcript = Array.isArray(message.history) ? message.history : [];
          this.saveCurrentChat();
          break;
        case "requestHistory":
          this.postHistory();
          break;
        case "openChat":
          await this.openChat(String(message.id ?? ""));
          break;
        case "deleteChat":
          await this.deleteChat(String(message.id ?? ""));
          break;
      }
    });

    view.onDidDispose(() => {
      this.view = undefined;
      this.cancelPendingPermissions();
      // Nothing left to report progress to, and the poll would outlive the panel.
      this.setup.stop();
    });
  }

  // ---- chat history ----------------------------------------------------

  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  }

  private allChats(): ChatRecord[] {
    return this.store.get<ChatRecord[]>(HISTORY_KEY, []);
  }

  /**
   * Keep the chat on screen. Called after every turn, so reopening VS Code
   * finds the conversation where it was left rather than gone.
   *
   * An empty chat is not worth a row in the list, and a chat with no folder
   * could never be resumed against the right cwd, so neither is saved.
   */
  private saveCurrentChat(): void {
    if (this.transcript.length === 0) return;
    const cwd = this.workspaceCwd();
    if (!cwd) return;

    const record: ChatRecord = {
      id: this.chatId,
      sessionId: this.session.currentSessionId,
      cwd,
      title: titleFrom(this.transcript),
      updatedAt: Date.now(),
      messageCount: this.transcript.length,
      history: this.transcript,
    };

    const kept = pruneHistory(upsertRecord(this.allChats(), record), MAX_CHATS);
    void this.store.update(HISTORY_KEY, kept);
  }

  /** Send the list the webview draws. Only this folder's chats. */
  private postHistory(): void {
    const mine = forWorkspace(this.allChats(), this.workspaceCwd());
    this.post({
      type: "history",
      canResume: this.session.canLoadSessions,
      openId: this.chatId,
      groups: groupByDay(mine, Date.now()).map((group) => ({
        label: group.label,
        chats: group.records.map((r) => ({
          id: r.id,
          title: r.title,
          messageCount: r.messageCount,
          at: new Date(r.updatedAt).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }),
          resumable: Boolean(r.sessionId),
        })),
      })),
    });
  }

  /**
   * Reopen a past chat. The transcript is redrawn from our own copy; Kiro is
   * asked to load the session so it has the conversation in mind and the user
   * can carry on. If that fails the transcript is still shown, read-only —
   * seeing it is more useful than an error.
   */
  private async openChat(id: string): Promise<void> {
    const record = this.allChats().find((r) => r.id === id);
    if (!record) {
      vscode.window.showWarningMessage("That chat is no longer stored.");
      return;
    }

    // Whatever is on screen now is not lost by opening something else.
    this.saveCurrentChat();

    this.chatId = record.id;
    this.transcript = record.history ?? [];
    this.attachments = [];
    this.postAttachments();
    this.post({ type: "openChat", history: this.transcript, title: record.title });

    if (!record.sessionId) {
      this.post({ type: "chatReadOnly", why: "This chat was never given a Kiro session." });
      return;
    }

    try {
      await this.session.loadSession(record.sessionId);
      this.everConnected = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`Could not reopen chat ${id}: ${message}`);
      this.post({
        type: "chatReadOnly",
        why: `Kiro could not reopen this conversation: ${message}`,
      });
    }
  }

  private async deleteChat(id: string): Promise<void> {
    const kept = this.allChats().filter((r) => r.id !== id);
    await this.store.update(HISTORY_KEY, kept);
    // Deleting the chat you are looking at leaves you in a fresh one.
    if (id === this.chatId) {
      this.chatId = freshId();
      this.transcript = [];
      this.post({ type: "cleared" });
    }
    this.postHistory();
  }

  showHistory(): void {
    this.focus();
    this.postHistory();
    this.post({ type: "showHistory" });
  }

  /**
   * The title bar button. The panel decides whether that means opening or
   * closing, and asks for a refresh itself if it has nothing to show — one
   * place owns the toggle rather than two disagreeing about it.
   */
  showUsage(): void {
    this.focus();
    this.post({ type: "toggleUsage" });
  }

  // ---- setup screen ----------------------------------------------------

  /**
   * Kiro could not start. Show the setup screen once and, when the binary is
   * simply not there yet, start watching for it. Later failures are the
   * watcher's own retries; they must not restart the screen underneath it.
   */
  private onNeedsSetup(reason: "missing" | "signin" | "failed", detail?: string): void {
    if (this.setupActive) return;

    // Kiro has worked in this window before, so this is a reconnect, not a
    // first run. Retry quietly behind the loading state: a torn-down client
    // or a slow spawn fixes itself, and throwing a setup screen at someone
    // who was chatting seconds ago is how "restart" came to mean "log in
    // again". Only a real sign-in error skips the retries.
    if (this.everConnected && reason !== "signin") {
      this.setup.reconnect();
      return;
    }

    this.setupActive = true;
    this.post({ type: "needsSetup", reason, detail });
    if (reason === "missing") this.setup.start();
  }

  private onSetupState(state: string, detail?: string): void {
    this.output.appendLine(`Setup: ${state}${detail ? ` (${detail})` : ""}`);

    // The quiet retries of a reconnect ran out. Now it is worth interrupting,
    // and the screen leads with what actually broke rather than the login.
    if (state === "failed") {
      this.setupActive = true;
      this.post({ type: "needsSetup", reason: "failed", detail });
      return;
    }

    this.post({ type: "setupState", state, detail });
    if (state === "connected") {
      this.setupActive = false;
      this.everConnected = true;
    }
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
    // This setting was declared but never read, so the toggle did nothing.
    // It seeds whether the highlighted code goes with the first message.
    this.post({
      type: "defaults",
      sendSelection: vscode.workspace
        .getConfiguration("kiroChat")
        .get<boolean>("sendSelection", true),
    });

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

  private requestPermissionInChat(request: {
    title: string;
    options: Array<{ id: string; label: string; kind: string }>;
  }): Promise<string | undefined> {
    if (!this.view) return Promise.resolve(undefined);
    const requestId = freshId();
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, resolve);
      this.post({ type: "permission", permission: { requestId, ...request } });
    });
  }

  private cancelPendingPermissions(): void {
    for (const resolve of this.pendingPermissions.values()) resolve(undefined);
    this.pendingPermissions.clear();
  }

  /** The live Kiro session, shared with the @kiro chat participant so both
   *  boxes talk to one conversation rather than two agents. */
  get kiroSession(): KiroSession {
    return this.session;
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
        // The file being looked at, shown as its own chip and sent with the
        // message so Kiro can open it — the way Copilot Chat behaves.
        activeFile: this.activeFile(),
      });
    };
    if (immediate) {
      run();
    } else {
      this.selectionTimer = setTimeout(run, 150);
    }
  }

  /**
   * The file the editor is showing, if it is one Kiro could open. Turned off
   * by `kiroChat.attachActiveFile`, and absent for untitled or virtual
   * documents, which have nothing on disk to attach.
   */
  private activeFile(): ActiveFile | undefined {
    const on = vscode.workspace
      .getConfiguration("kiroChat")
      .get<boolean>("attachActiveFile", true);
    if (!on) return undefined;
    if (!this.selection?.fsPath) return undefined;
    return { path: this.selection.fsPath, label: this.selection.relativePath };
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

  /**
   * Something was dropped on the panel. The webview hands over every format
   * the drag carried, because which ones are filled in depends on where it
   * came from.
   *
   * A drop that yields nothing is logged with the formats that were on offer.
   * Without that there is no way to tell a drop that was not understood from
   * one that never reached the panel at all, and the difference decides
   * whether the fix is here or somewhere else entirely.
   */
  private async handleDrop(
    values: unknown[],
    types: unknown[] = [],
    fileCount = 0
  ): Promise<void> {
    const paths = parseDroppedPaths(values);
    this.output.appendLine(
      `Drop: ${paths.length} path(s) from ${values.length} value(s); ` +
        `formats offered: [${types.map(String).join(", ")}]; files: ${fileCount}`
    );

    if (paths.length === 0) {
      if (fileCount === 0 && types.length === 0) {
        this.output.appendLine(
          "The drop carried no data at all. If the panel highlighted as you " +
            "dragged, the drag reached it but VS Code offered nothing to read."
        );
      }
      return;
    }

    const uris = paths.map((p) => vscode.Uri.file(p));
    const added = await attachmentsFromUris(uris);
    await this.addAttachments(added);
    if (added.length > 0) {
      this.post({ type: "insertMentions", labels: added.map((a) => a.label) });
    } else {
      this.output.appendLine(
        `None of the dropped paths could be read: ${paths.join(", ")}`
      );
    }
  }

  /**
   * A data URI the webview can put in an <img>, or undefined to leave the
   * attachment as a text chip. The page's CSP already allows `data:` images.
   *
   * Very large images are skipped: the preview is rendered a few dozen pixels
   * wide, and pushing megabytes through postMessage to draw a thumbnail is not
   * a trade worth making.
   */
  private previewOf(attachment: Attachment): string | undefined {
    if (attachment.kind !== "image" || !attachment.data) return undefined;
    // base64 carries 3 bytes in every 4 characters.
    const bytes = Math.floor((attachment.data.length * 3) / 4);
    if (bytes > MAX_PREVIEW_BYTES) return undefined;
    return `data:${attachment.mimeType ?? "image/png"};base64,${attachment.data}`;
  }

  private postAttachments(): void {
    this.post({
      type: "attachments",
      attachments: this.attachments.map((a) => ({
        id: a.id,
        kind: a.kind,
        label: a.label,
        path: a.path,
        preview: this.previewOf(a),
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

  async send(
    text: string,
    includeSelection: boolean,
    includeActiveFile = true,
    modeValue: unknown = "default"
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed && this.attachments.length === 0) return;

    this.selection = readSelection();
    // The file on screen goes along too, unless the user dismissed its chip.
    // A file already attached by hand wins, so nothing is sent twice.
    const attached = attachmentsForMessage(
      [...this.attachments],
      this.activeFile(),
      includeActiveFile
    ) as Attachment[];

    const mode = chatMode(modeValue);
    this.post({
      type: "userMessage",
      text: trimmed,
      mode: mode.id,
      modeLabel: mode.label,
      // The preview goes with the sent message too, so the transcript shows
      // the picture you sent rather than its filename.
      attachments: attached.map((a) => ({
        kind: a.kind,
        label: a.label,
        preview: this.previewOf(a),
      })),
      selection:
        includeSelection && this.selection?.hasSelection
          ? `${this.selection.relativePath}:${this.selection.startLine}-${this.selection.endLine}`
          : undefined,
    });

    const blocks = applyChatMode(
      buildBlocks(trimmed, attached, this.selection, includeSelection),
      mode
    );

    this.attachments = [];
    this.postAttachments();

    this.everConnected = true;
    await this.session.send(blocks, { readOnly: mode.readOnly === true });
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
    this.cancelPendingPermissions();
    // Keep what is on screen before it is thrown away. This used to lose the
    // conversation outright.
    this.saveCurrentChat();
    this.chatId = freshId();
    this.transcript = [];

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
    this.cancelPendingPermissions();
    for (const w of this.watchers) w.dispose();
    this.setup.stop();
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
  <div id="status" class="status" data-state="stopped">Not connected</div>

  <div class="usage-wrap">
    <button type="button" id="usage-bar" class="usage-bar" hidden aria-expanded="false"
      title="Credits and context. Click for your account usage.">
      <div class="usage-track"><div id="usage-fill" class="usage-fill"></div></div>
      <span id="usage-text" class="usage-text"></span>
      <span class="caret">&#9662;</span>
    </button>
    <div id="usage-panel" class="usage-panel" hidden></div>
  </div>

  <div id="messages" class="messages" role="log" aria-live="polite">
    <div class="empty">
      <p>Ask Kiro about your code.</p>
      <p class="hint">Enter sends, Shift+Enter starts a new line. Hold Shift and drag files here to attach them, or paste a screenshot.</p>
    </div>
  </div>

  <div id="dropzone" class="dropzone" hidden><span>Drop anywhere here to attach</span></div>

  <form id="composer" class="composer">
    <div id="chips" class="chips" hidden></div>

    <textarea id="input" rows="2" placeholder="Ask Kiro&#8230;"></textarea>

    <div class="composer-row">
      <div class="attach-wrap">
        <button type="button" id="attach" class="icon" title="Attach files, folders or an image" aria-haspopup="true" aria-expanded="false">+</button>
        <div id="attach-menu" class="popup" hidden>
          <button type="button" data-act="attachFiles">Files from this project</button>
          <button type="button" data-act="attachFolders">A folder</button>
          <button type="button" data-act="attachImage">An image</button>
        </div>
      </div>
      <div class="mode-wrap">
        <button type="button" id="mode-btn" class="mode-btn" aria-haspopup="listbox" aria-expanded="false">
          <span id="mode-label">Default</span>
          <span class="caret">&#9662;</span>
        </button>
        <div id="mode-menu" class="mode-menu" hidden role="listbox"></div>
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
