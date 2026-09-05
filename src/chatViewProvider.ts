import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
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
import { EditGates, editModeOf, gatesForMode } from "./editModes";
import { parseDroppedPaths } from "./dropped";
import { findKiro } from "./findKiro";
import { SetupWatcher } from "./setupWatcher";
import {
  ChatRecord,
  forWorkspace,
  groupByDay,
  HistoryItem,
  previewOf,
  pruneHistory,
  stableTitle,
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

/**
 * How long a pending permission survives the view going away.
 *
 * `onDidDispose` cannot tell a panel being dragged from one being closed for
 * good — both destroy the webview, and only what happens next tells them
 * apart: a drag resolves a new view within milliseconds, a close never does.
 * Cancelling immediately answered Kiro on the user's behalf every time they
 * rearranged their editor; not cancelling at all left Kiro waiting on a panel
 * that was never coming back. Waiting turns the guess into an observation.
 *
 * Thirty seconds is far longer than a drag and short enough that an abandoned
 * turn is not left hanging. Nothing is lost by being wrong in the slow
 * direction: this is the behaviour the code already had, only delayed.
 */
const PERMISSION_GRACE_MS = 30_000;

/**
 * The settings the panel is allowed to write, and the only ones.
 *
 * `setSetting` takes a key from the webview, so it is a write primitive with
 * an untrusted argument. An allow-list keeps it to the five toggles the menu
 * actually offers rather than letting anything in the `kiroChat` section — or
 * a mistyped one — be set from a message.
 *
 * All five are booleans with a declared default in package.json, which is
 * what makes reading them uniform.
 */
const PANEL_SETTINGS = [
  "allowFileWrites",
  "reviewFileWrites",
  "askBeforeEdits",
  "autoApproveTools",
  "attachActiveFile",
  "sendSelection",
] as const;

function freshId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The page's CSP nonce.
 *
 * Being unpredictable is the entire job of this value, and Math.random() is
 * not: it is seeded per process and its output is recoverable from a few
 * samples. `randomBytes` costs nothing here — one call per webview.
 */
function nonce(): string {
  return randomBytes(16).toString("base64");
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
  /**
   * Permission requests Kiro is still waiting on.
   *
   * The request itself is kept beside its resolver, not just the resolver,
   * because the webview is destroyed and rebuilt whenever the panel is
   * dragged between the sidebar, the bottom panel and the secondary sidebar.
   * The card goes with it, and the question has to be asked again on the
   * other side; see `repostPermissions`.
   */
  /** Runs while the view is gone but might still come back. */
  private permissionGrace: NodeJS.Timeout | undefined;
  private readonly pendingPermissions = new Map<
    string,
    {
      resolve: (optionId: string | undefined) => void;
      request: { title: string; options: Array<{ id: string; label: string; kind: string }> };
    }
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
  /**
   * Kiro's session for the chat on screen, when it is a reopened one.
   * Undefined means "this chat owns whatever session is live", which is the
   * case for every new chat.
   */
  private chatSessionId: string | undefined;
  /** The transcript, as the webview reports it after each turn. */
  private transcript: HistoryItem[] = [];
  /** True when the webview could only send us the tail of a longer chat. */
  private transcriptTruncated = false;
  /** The chat waiting to be written, held back so a turn is one write. */
  private pendingChat: ChatRecord | undefined;
  private flushTimer: NodeJS.Timeout | undefined;

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
      onReviewActive: (info) => this.post({ type: "reviewActive", review: info }),
      onTurnChanges: (summary) => this.post({ type: "turnChanges", ...summary }),
    });

    // Track where the user is working, so the chip stays current.
    this.watchers.push(
      vscode.window.onDidChangeTextEditorSelection(() => this.refreshSelection()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshSelection()),
      /*
       * The settings menu is a view of the settings, not a copy of them.
       *
       * Changing one in the VS Code settings editor, in another window, or in
       * the JSON has to reach the menu too, or the panel shows a state that is
       * not the one in force. It is also what confirms the menu's own writes:
       * a row flips because the setting changed, never because it was clicked.
       */
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("kiroChat")) return;
        this.postSettings();
        // `attachActiveFile` decides whether there is a file chip at all.
        this.refreshSelection(true);
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    // A view came back, so the last dispose was a move rather than a close.
    // The questions Kiro is still waiting on are re-posted by
    // `onWebviewReady`; all this has to do is call off their execution.
    this.keepPermissionsAlive();
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
          // Through `stop()`, not around it. This case used to cancel pending
          // permissions and the `kiroChat.stop` command did not, so stopping
          // from the Command Palette left a live card answering to nobody.
          this.stop();
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
          // A fresh connection is a fresh chat. Without this the conversation
          // that follows was written into the previous chat's record, which
          // upsert then replaced — the old chat vanished with no delete.
          this.beginFreshChat();
          this.post({ type: "cleared" });
          await this.session.newSession().catch(() => undefined);
          break;
        case "openSettings":
          void vscode.commands.executeCommand("workbench.action.openSettings", "kiroChat");
          break;
        case "showLog":
          this.output.show(true);
          break;
        case "setEditMode": {
          /*
           * One click, four settings. `gatesForMode` refuses anything that is
           * not a named mode, so `custom` — which is a reading of the settings
           * rather than a choice — cannot be applied, and neither can a
           * mistyped name.
           */
          const gates = gatesForMode(String(message.mode ?? ""));
          if (!gates) break;
          const config = vscode.workspace.getConfiguration("kiroChat");
          for (const [key, value] of Object.entries(gates)) {
            await config.update(key, value, vscode.ConfigurationTarget.Global);
          }
          break;
        }
        case "setSetting": {
          const key = String(message.key ?? "");
          // An untrusted key from a message is not a licence to write any
          // setting in the section, or one that does not exist.
          if (!(PANEL_SETTINGS as readonly string[]).includes(key)) break;
          await vscode.workspace
            .getConfiguration("kiroChat")
            .update(key, message.value === true, vscode.ConfigurationTarget.Global);
          // Nothing is posted back here. The configuration watcher sees the
          // write land and re-posts, so a toggle that failed does not leave a
          // row claiming a state the setting is not in.
          break;
        }
        case "permissionDecision": {
          const requestId = String(message.requestId ?? "");
          const pending = this.pendingPermissions.get(requestId);
          /*
           * The card is told either way, and only writes its answer down when
           * it hears back.
           *
           * It used to disable itself and say "Selected: Allow" the instant it
           * was clicked, whatever happened next. A request that had already
           * gone — the turn ended, was stopped, or errored — was dropped here
           * in silence, so a card sat in the transcript claiming an approval
           * that never reached Kiro.
           */
          if (!pending) {
            this.post({ type: "permissionSettled", requestId, ok: false });
            break;
          }
          this.pendingPermissions.delete(requestId);
          const optionId = message.optionId === undefined ? undefined : String(message.optionId);
          pending.resolve(optionId);
          this.post({ type: "permissionSettled", requestId, ok: true, optionId });
          break;
        }
        case "transcript":
          // The webview keeps the transcript already; this is it reporting in
          // after a turn so the same copy can outlive the panel.
          this.transcript = Array.isArray(message.history) ? message.history : [];
          this.transcriptTruncated = message.truncated === true;
          this.saveCurrentChat();
          break;
        case "keepChanges":
          // A review on screen is the live thing to answer; once it has
          // settled, the same button just stops offering the undo.
          await this.session.acceptActiveReview();
          this.session.keepLastTurn();
          break;
        case "gotoChange":
          await this.session.gotoNextChange();
          break;
        case "undoChanges": {
          await this.session.rejectActiveReview();
          const restored = await this.session.undoLastTurn();
          this.post({ type: "changesUndone", restored });
          break;
        }
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
      /*
       * Pending permissions get a stay of execution, not a pardon.
       *
       * Dragging the panel between the sidebar, the bottom panel and the
       * secondary sidebar disposes the view and resolves a new one — the same
       * conversation, a new webview. Cancelling here answered Kiro on the
       * user's behalf for a move made for layout reasons, and told nobody.
       * Never cancelling is the opposite mistake: a view closed for good would
       * leave Kiro waiting on a card that is not coming back.
       *
       * So wait and see. `resolveWebviewView` calls this off; if nothing
       * resolves, the timer does what this line used to do immediately.
       */
      this.schedulePermissionCancel();
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
   * Write the pending chat out. Debounced, because `saveCurrentChat` runs on
   * every message and each write serialises every chat we hold — the records
   * carry whole transcripts, so a turn was moving megabytes several times.
   *
   * Only the one chat is held back, and the list it joins is read at write
   * time. Caching the list instead would let a second VS Code window's saves
   * be overwritten by this one's stale copy.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushChats(), 500);
  }

  /** Write immediately — before anything that must not be lost. */
  private flushChats(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    const record = this.pendingChat;
    if (!record) return;
    this.pendingChat = undefined;
    const kept = pruneHistory(upsertRecord(this.allChats(), record), MAX_CHATS);
    void this.store.update(HISTORY_KEY, kept);
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

    const existing =
      this.pendingChat?.id === this.chatId
        ? this.pendingChat
        : this.allChats().find((r) => r.id === this.chatId);
    const record: ChatRecord = {
      id: this.chatId,
      // `chatSessionId` is set when a past chat is reopened, and stays set
      // until a new chat begins. Reading the live session here instead let a
      // transcript arriving while `session/load` was still in flight stamp the
      // *previous* chat's session onto this record — after which reopening it
      // resumed the wrong conversation.
      sessionId: this.chatSessionId ?? this.session.currentSessionId,
      cwd,
      title: stableTitle(existing?.title, this.transcript),
      updatedAt: Date.now(),
      messageCount: this.transcript.length,
      history: this.transcript,
      truncated: this.transcriptTruncated,
    };

    this.pendingChat = record;
    this.scheduleFlush();
  }

  /** Put the chat on screen away and begin a fresh one. */
  private beginFreshChat(): void {
    this.saveCurrentChat();
    this.flushChats();
    this.chatId = freshId();
    // Undefined means "whatever session is live is this chat's".
    this.chatSessionId = undefined;
    this.transcript = [];
    this.transcriptTruncated = false;
  }

  /** Send the list the webview draws. Only this folder's chats. */
  private postHistory(): void {
    // The chat on screen may still be waiting on the debounce, and a list
    // that leaves out the conversation you are in reads as a bug.
    this.flushChats();
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
          // Titles repeat — real chats open with "fix this" — so the newest
          // line is what actually tells two rows apart.
          preview: previewOf(r.history ?? []),
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
    this.flushChats();

    this.chatId = record.id;
    // Pin the session this chat belongs to before anything can report a
    // transcript back, so reading a chat cannot rebind it to another one.
    this.chatSessionId = record.sessionId;
    this.transcript = record.history ?? [];
    this.transcriptTruncated = record.truncated === true;
    this.attachments = [];
    this.postAttachments();
    this.post({
      type: "openChat",
      history: this.transcript,
      title: record.title,
      truncated: this.transcriptTruncated,
    });

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
    // A save still waiting on the debounce would put the record straight back.
    if (this.pendingChat?.id === id) this.pendingChat = undefined;
    this.flushChats();
    await this.store.update(
      HISTORY_KEY,
      this.allChats().filter((r) => r.id !== id)
    );
    // Deleting the chat you are looking at leaves you in a fresh one.
    if (id === this.chatId) {
      this.chatId = freshId();
      this.chatSessionId = undefined;
      this.transcript = [];
      this.transcriptTruncated = false;
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
    // A question Kiro is still waiting on outlived the panel being rebuilt,
    // so put the card back rather than leaving the turn stuck behind one the
    // user can no longer see.
    this.repostPermissions();

    const state = this.session.getModels();
    if (state.models.length > 0) {
      this.post({ type: "models", models: state.models, currentModelId: state.currentModelId });
    }
    this.post({ type: "capabilities", caps: { image: this.session.canSendImages } });
    this.post({ type: "status", status: this.session.currentStatus });
    this.postSettings();

    if (restored) {
      const usage = this.session.getUsage();
      if (Object.keys(usage).length > 0) {
        this.post({ type: "usage", usage });
      }
      void this.session.ensureReady().catch(() => undefined);
      return;
    }

    // Blank panel. Make Kiro's memory match what the user is looking at —
    // and our bookkeeping too, or the new conversation is saved over the one
    // the panel was showing before it was rebuilt.
    this.attachments = [];
    this.postAttachments();
    try {
      if (this.everConnected) {
        this.beginFreshChat();
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

  /**
   * The five toggles the panel shows, as they actually are right now.
   *
   * This replaced a `defaults` message that carried `sendSelection` alone.
   * Adding the menu beside it would have given that one setting two writers in
   * the webview — the exact drift this codebase keeps paying for elsewhere —
   * so there is one message, and `includeSelection` is derived from it.
   */
  private postSettings(): void {
    const config = vscode.workspace.getConfiguration("kiroChat");
    const settings: Record<string, boolean> = {};
    for (const key of PANEL_SETTINGS) settings[key] = Boolean(config.get<boolean>(key));
    // Derived here rather than stored, so it cannot disagree with the settings
    // it describes — and reported as `custom` when it matches no mode.
    this.post({
      type: "settings",
      settings,
      editMode: editModeOf(settings as unknown as EditGates),
    });
  }

  private requestPermissionInChat(request: {
    title: string;
    options: Array<{ id: string; label: string; kind: string }>;
  }): Promise<string | undefined> {
    if (!this.view) return Promise.resolve(undefined);
    const requestId = freshId();
    return new Promise((resolve) => {
      this.pendingPermissions.set(requestId, { resolve, request });
      this.post({ type: "permission", permission: { requestId, ...request } });
    });
  }

  /**
   * Ask again after the panel has been rebuilt.
   *
   * Moving the view destroys the webview, and the card with it. This used to
   * answer Kiro "cancelled" on the user's behalf and say so nowhere: the
   * action they were being asked about simply did not happen, and the panel
   * that came back showed no sign there had ever been a question. The request
   * is still open on Kiro's side, so the honest thing is to put it back.
   */
  private repostPermissions(): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      this.post({ type: "permission", permission: { requestId, ...pending.request } });
    }
  }

  /**
   * The view has gone. Give it a moment to come back before answering for it.
   *
   * Nothing is scheduled when there is nothing outstanding, so the ordinary
   * case — closing a panel with no question on screen — starts no timer at
   * all.
   */
  private schedulePermissionCancel(): void {
    if (this.pendingPermissions.size === 0) return;
    this.keepPermissionsAlive();
    this.permissionGrace = setTimeout(() => {
      this.permissionGrace = undefined;
      if (this.pendingPermissions.size === 0) return;
      // Said out loud, because nobody is looking at a panel to be told.
      this.output.appendLine(
        `The chat panel closed with ${this.pendingPermissions.size} permission request(s) ` +
          `still open. Answering Kiro "cancelled" for them.`
      );
      this.cancelPendingPermissions();
    }, PERMISSION_GRACE_MS);
  }

  /** A view resolved, or we are tearing down for real. Call off the timer. */
  private keepPermissionsAlive(): void {
    if (!this.permissionGrace) return;
    clearTimeout(this.permissionGrace);
    this.permissionGrace = undefined;
  }

  /**
   * Answer everything still open with "cancelled".
   *
   * Every card is told, so none is left looking live. A card whose request has
   * gone is worse than no card: its buttons still work, and clicking one used
   * to report a decision that reached nobody.
   */
  private cancelPendingPermissions(): void {
    for (const [requestId, pending] of this.pendingPermissions) {
      pending.resolve(undefined);
      this.post({ type: "permissionSettled", requestId, ok: false });
    }
    this.pendingPermissions.clear();
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
        // Already sent with an earlier message. The chip row uses it to
        // decide whether a blank composer has anything new to say.
        carried: a.carried === true,
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
    // Same rule the composer applies: chips that have already gone are not on
    // their own a message. A command reaching here always brings text.
    if (!trimmed && !this.attachments.some((a) => a.carried !== true)) return;

    /*
     * Refused before the bubble is posted, not after.
     *
     * The webview disables Send while a turn runs, but a command does not go
     * through the webview at all — kiroChat.explainSelection lands here
     * directly, as does anything else calling sendFromEditor. Checking here
     * rather than letting KiroSession throw means a refused message leaves no
     * orphan bubble in the transcript, and the user's text is still theirs.
     */
    if (this.session.currentStatus === "busy") {
      vscode.window.showWarningMessage(
        "Kiro is still working on the last message. Wait for it to finish."
      );
      return;
    }

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
        // Which chip may step aside for the selection tag. Only the automatic
        // one may: a file attached by hand is a separate thing the user did,
        // and hiding it under a range they happen to have highlighted loses
        // the only record that it went.
        source: a.source ?? "user",
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

    /*
     * Files and folders stay attached; an image does not.
     *
     * Clearing the whole row after every message meant "add another file to
     * the context" was only ever true for one message: the second message
     * carried strictly less than the first, the automatic file chip came back
     * on its own so the row still looked populated, and nothing anywhere said
     * the rest had gone. A file reference costs a path — keeping it is what
     * the chip already implies. An image is the opposite: its base64 rides in
     * the prompt itself, so a sticky one would re-send megabytes every turn
     * for a picture Kiro has already been shown. Remove one with its ×, or
     * clear the row from the chip bar.
     */
    this.attachments = this.attachments
      .filter((a) => a.kind !== "image")
      // Marked as carried so an empty box cannot send them a second time on
      // its own. Enter on a blank composer used to be a no-op; with the row
      // still full it would start a real turn, which costs credits and runs
      // Kiro against a message the user never wrote. Attaching something new
      // clears the mark, because "look at this" with no words is a real thing
      // to send — once.
      .map((a) => ({ ...a, carried: true }));
    this.postAttachments();

    this.everConnected = true;
    try {
      await this.session.send(blocks, { readOnly: mode.readOnly === true });
    } catch (err) {
      // A turn reports its own failures through onError. The only thing that
      // reaches here is one refused before it started — a race with the guard
      // above — and the transcript is already showing a bubble for it, so the
      // turn has to be ended rather than left spinning.
      const message = err instanceof Error ? err.message : String(err);
      this.post({ type: "error", text: message });
      this.post({ type: "turnEnd", reason: "error" });
    }
  }

  async sendFromEditor(text: string): Promise<void> {
    this.focus();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await this.send(text, true);
  }

  stop(): void {
    // Abandoning the turn abandons every question it was still asking. Both
    // the Stop button and the `kiroChat.stop` command land here so they cannot
    // disagree about that.
    this.cancelPendingPermissions();
    this.session.cancel();
  }

  async newSession(): Promise<void> {
    this.cancelPendingPermissions();
    // Keep what is on screen before it is thrown away. This used to lose the
    // conversation outright.
    this.beginFreshChat();

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
    // A debounced save must not be lost to the window closing.
    this.flushChats();
    // No waiting to see here: this is the real teardown, and a timer left
    // running would outlive the thing it was going to act on.
    this.keepPermissionsAlive();
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
    <div id="permission-bar" class="permission-bar" hidden></div>
    <div id="change-bar" class="change-bar" hidden></div>
    <div id="chips" class="chips" hidden></div>

    <textarea id="input" rows="2" placeholder="Ask Kiro&#8230;"></textarea>

    <div class="composer-row">
      <div class="attach-wrap">
        <button type="button" id="attach" class="icon" title="Attach files, folders or an image" aria-label="Attach files, folders or an image" aria-haspopup="true" aria-expanded="false">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M8.5 3a.5.5 0 0 0-1 0v4.5H3a.5.5 0 0 0 0 1h4.5V13a.5.5 0 0 0 1 0V8.5H13a.5.5 0 0 0 0-1H8.5V3Z"/></svg>
        </button>
        <div id="attach-menu" class="popup" hidden>
          <button type="button" data-act="attachFiles">Files from this project</button>
          <button type="button" data-act="attachFolders">A folder</button>
          <button type="button" data-act="attachImage">An image</button>
        </div>
      </div>
      <div class="mode-wrap">
        <button type="button" id="mode-btn" class="mode-btn" title="Workflow" aria-haspopup="listbox" aria-expanded="false">
          <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 4.5A.5.5 0 0 1 2.5 4h5a.5.5 0 0 1 0 1h-5a.5.5 0 0 1-.5-.5Zm0 3.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11A.5.5 0 0 1 2 8Zm0 3.5a.5.5 0 0 1 .5-.5h8a.5.5 0 0 1 0 1h-8a.5.5 0 0 1-.5-.5Z"/></svg>
          <span id="mode-label">Default</span>
        </button>
        <div id="mode-menu" class="mode-menu" hidden role="listbox"></div>
      </div>
      <div class="model-wrap">
        <button type="button" id="model-btn" class="model-btn" title="Model" aria-haspopup="listbox" aria-expanded="false" disabled>
          <svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 1.5a.5.5 0 0 1 1 0V3h2V1.5a.5.5 0 0 1 1 0V3h.5A1.5 1.5 0 0 1 12 4.5V5h1.5a.5.5 0 0 1 0 1H12v2h1.5a.5.5 0 0 1 0 1H12v.5a1.5 1.5 0 0 1-1.5 1.5H10v1.5a.5.5 0 0 1-1 0V11H7v1.5a.5.5 0 0 1-1 0V11h-.5A1.5 1.5 0 0 1 4 9.5V9H2.5a.5.5 0 0 1 0-1H4V6H2.5a.5.5 0 0 1 0-1H4v-.5A1.5 1.5 0 0 1 5.5 3H6V1.5ZM5 4.5v5a.5.5 0 0 0 .5.5h5a.5.5 0 0 0 .5-.5v-5a.5.5 0 0 0-.5-.5h-5a.5.5 0 0 0-.5.5Z"/></svg>
          <span id="model-label">Default model</span>
        </button>
        <div id="model-menu" class="model-menu" hidden role="listbox"></div>
      </div>
      <span class="spacer"></span>
      <button type="button" id="stop" class="icon danger" hidden title="Stop this reply" aria-label="Stop this reply">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>
      </button>
      <button type="submit" id="send" class="icon primary" title="Send" aria-label="Send">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M2 8a.75.75 0 0 1 .75-.75h8.19L7.72 4.03a.75.75 0 0 1 1.06-1.06l4.5 4.5a.75.75 0 0 1 0 1.06l-4.5 4.5a.75.75 0 1 1-1.06-1.06l3.22-3.22H2.75A.75.75 0 0 1 2 8Z"/></svg>
      </button>
    </div>
  </form>

  <script nonce="${n}" src="${media("chat.js")}"></script>
</body>
</html>`;
  }
}
