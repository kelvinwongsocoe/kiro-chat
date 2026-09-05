import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { AcpClient } from "./acpClient";
import { ActiveReviewInfo, ChangeReviewer } from "./changeReviewer";
import { isReadOnlyTool, isWriteLikeTool } from "./writeTools";
import { changedSinceBaseline, describeChange, TurnChange } from "./turnChanges";
import { findKiro } from "./findKiro";
import { isInsideAnyRoot, isInsideRoot } from "./workspacePaths";
import { looksLikeSignIn } from "./startupError";
import {
  creditRateOf,
  describeContextWindow,
  formatUsageReport,
  parseAccountUsage,
  readMeter,
  readModelDetails,
  readUsageCommand,
  UsageInfo,
} from "./usage";

export { formatUsageReport, parseAccountUsage, readUsageCommand, UsageInfo };

/** What one of Kiro's own commands answered. */
export interface CommandResult {
  ok: boolean;
  /** The structured payload, when the command has one. */
  data?: any;
  /** Anything printable, for showing the user when data is not enough. */
  text: string;
}

export type SessionStatus = "stopped" | "starting" | "ready" | "busy";

export interface ModelInfo {
  modelId: string;
  name: string;
  description?: string;
  /** e.g. "1.0x" — only set when Kiro actually tells us. */
  creditRate?: string;
  /** e.g. "1M context" — likewise. */
  contextWindow?: string;
}

/** An ACP content block: text, an image, or a pointer to a file. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource_link"; uri: string; name: string; mimeType?: string };

export interface SendOptions {
  /** Refuse and restore all writes made during this turn. */
  readOnly?: boolean;
}

export interface SessionEvents {
  onStatus: (status: SessionStatus, detail?: string) => void;
  onText: (text: string) => void;
  onThought: (text: string) => void;
  onTool: (tool: ToolStep) => void;
  onTurnEnd: (reason?: string) => void;
  onError: (message: string) => void;
  onNeedsSetup: (reason: "missing" | "signin" | "failed", detail?: string) => void;
  onModels: (models: ModelInfo[], currentModelId: string) => void;
  onUsage: (usage: UsageInfo) => void;
  onCapabilities: (caps: { image: boolean }) => void;
  /** A review is on screen, so the chat can offer to keep or undo the lot. */
  onReviewActive?: (info: ActiveReviewInfo | undefined) => void;
  /** What the turn changed on disk, so the chat can offer keep or undo. */
  onTurnChanges?: (summary: { text: string; files: TurnChange[] }) => void;
  onPermission?: (request: {
    title: string;
    options: Array<{ id: string; label: string; kind: string }>;
  }) => Promise<string | undefined>;
}

/**
 * What the review applier last left on disk, as read back rather than as
 * requested. Save participants can change it on the way through.
 */
interface AppliedState {
  exists?: boolean;
  content?: string;
}

interface FileSnapshot {
  full: string;
  exists: boolean;
  content: string;
}

interface DirectFileChange {
  before: FileSnapshot;
  /** What Kiro's tool input says the file should contain after this edit. */
  expected?: string;
}

function contentToText(content: any): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentToText).join("");
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (content.content) return contentToText(content.content);
  }
  return "";
}

/**
 * Readable names for the steps Kiro reports.
 *
 * Measured against kiro-cli 2.20.2: the first notification for a step is a
 * `tool_call_chunk` whose title is only the kind — literally `"read"` — and
 * the real title (`"Reading package.json:1"`) arrives with the `tool_call`
 * that follows. Showing "read" for that first moment is worse than showing a
 * verb, so a title that is nothing but the kind gets translated.
 */
const TOOL_VERBS: Record<string, string> = {
  read: "Reading",
  write: "Writing",
  fswrite: "Writing",
  edit: "Editing",
  strreplace: "Editing",
  search: "Searching",
  grep: "Searching",
  glob: "Finding files",
  list: "Listing",
  execute: "Running",
  shell: "Running",
  bash: "Running",
  fetch: "Fetching",
  think: "Thinking",
  delete: "Deleting",
  move: "Moving",
};

export interface ToolStep {
  id: string;
  title: string;
  status: string;
  /** Kiro's own note on why it is doing this, when it sends one. */
  purpose?: string;
}

export function describeTool(update: any): ToolStep {
  const kind = String(update?.kind ?? "").trim();
  const raw = String(update?.title ?? update?.rawInput?.command ?? kind ?? "tool").trim();
  const bare = raw.toLowerCase().replace(/[^a-z]/g, "");
  // Only a title that says nothing but the kind is replaced; a real one wins.
  const title =
    raw && bare === kind.toLowerCase().replace(/[^a-z]/g, "")
      ? TOOL_VERBS[bare] ?? (raw.charAt(0).toUpperCase() + raw.slice(1))
      : raw || "Working";

  const purpose = String(update?.rawInput?.__tool_use_purpose ?? "").trim();
  /*
   * A stable id when Kiro sends none.
   *
   * This used to fall back to Math.random(), which gave every notification
   * about one step a different id — so instead of a row updating in place, the
   * panel grew a fresh row for each update and a single step could fill the
   * list. Deriving it from what the step *is* collapses the repeats.
   *
   * It cannot do better than that: the three notifications for one step carry
   * different titles by design (see the comment above), so without a
   * toolCallId there is nothing that ties them together. This is strictly
   * fewer duplicate rows, not none.
   */
  const id =
    String(update?.toolCallId ?? update?.id ?? "").trim() || `${kind || "tool"}:${raw}`;
  return {
    id,
    title,
    // Only `tool_call_update` carries a status; the earlier two are underway.
    status: String(update?.status ?? "running"),
    purpose: purpose || undefined,
  };
}

/**
 * Whether a notification is a session update, under either name Kiro uses.
 *
 * Measured against kiro-cli 2.20.2 by capturing a whole turn: Kiro sends its
 * updates under **two** methods. `session/update` carries `tool_call`,
 * `tool_call_update` and every `agent_message_chunk`; `_kiro.dev/session/update`
 * carries the `tool_call_chunk` — the first word that a step is starting.
 *
 * Only the unprefixed name was accepted, so every one of those first
 * notifications was dropped at the door and merely logged. That is exactly the
 * window in which the panel has nothing to say but "Working…", and it is the
 * longest-feeling part of a turn. `_kiro.dev/metadata` had the same shape and
 * was already handled by naming both spellings; this does it for all of them.
 */
export function isSessionUpdate(method: string): boolean {
  const bare = String(method ?? "").replace(/^_?kiro\.dev\//, "");
  return bare === "session/update" || bare === "session/notification";
}

/**
 * How large a file to hold a pre-turn copy of.
 *
 * Baselines are taken for every file a tool mentions now, not only the ones
 * being written, so a turn that reads widely holds far more than it used to.
 * Source files are nowhere near this, and something that is would not make a
 * readable diff anyway.
 */
const MAX_BASELINE_BYTES = 10 * 1024 * 1024;

function normaliseKind(kind: unknown): string {
  return String(kind ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export class KiroSession {
  private client: AcpClient | undefined;
  private sessionId: string | undefined;
  private starting: Promise<void> | undefined;
  private status: SessionStatus = "stopped";
  private models: ModelInfo[] = [];
  private currentModelId = "";
  private usage: UsageInfo = {};
  private supportsImages = false;
  private supportsLoad = false;
  /** True while session/load runs, so a replay does not double-paint. */
  private replaying = false;
  private textSpy: ((text: string) => void) | undefined;
  private readonly changeReviewer: ChangeReviewer;
  /** Baselines are captured before Kiro's built-in tools can touch disk. */
  private readonly turnBaselines = new Map<string, FileSnapshot>();
  private readonly directFileChanges = new Map<string, DirectFileChange>();
  private readonly observedWriteTools = new Set<string>();
  /**
   * Every workspace path any tool mentioned this turn, write-like or not.
   *
   * This is what the end-of-turn review walks. A path only reaches it through
   * a tool call, so a file the *user* edited while the turn ran is not swept
   * into a diff offering to undo their own work.
   */
  private readonly toolTouchedPaths = new Set<string>();
  /** A write routed through the ACP fs callback must not be reviewed twice. */
  private readonly clientReviewedPaths = new Set<string>();
  /**
   * Files the user already answered for, hunk by hunk, in the diff.
   *
   * They gave a more precise answer than the keep-or-undo card can take, so
   * asking again afterwards is the same question a second time — and the
   * second one cannot be answered without contradicting the first.
   */
  private readonly answeredPaths = new Set<string>();
  private turnCancelled = false;
  /**
   * Pre-turn snapshots of everything the last turn changed, kept after the
   * turn so the keep-or-undo card can still put them back.
   */
  private lastTurnBaselines: FileSnapshot[] = [];
  private turnReadOnly = false;

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly events: SessionEvents
  ) {
    this.changeReviewer = new ChangeReviewer(output);
    // The chat mirrors the diff: while a review is open it can accept or
    // reject the whole file without walking every hunk.
    this.changeReviewer.onDidChangeActiveReview.event((info) =>
      this.events.onReviewActive?.(info)
    );
  }

  get currentStatus(): SessionStatus {
    return this.status;
  }

  get canSendImages(): boolean {
    return this.supportsImages;
  }

  /** Kiro's id for the running conversation, so it can be reopened later. */
  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  get canLoadSessions(): boolean {
    return this.supportsLoad;
  }

  /**
   * Reopen a past conversation so Kiro has its memory back and the user can
   * carry on talking. Verified against kiro-cli 2.20.2: a session id survives
   * the CLI process dying, so this works after a restart of VS Code.
   *
   * The panel redraws from our own stored transcript, not from Kiro. Kiro may
   * replay the conversation as session/update notifications while this call
   * is in flight, which would paint every message a second time, so those are
   * swallowed until it returns.
   */
  async loadSession(sessionId: string): Promise<void> {
    await this.ensureReady();
    if (!this.client?.isRunning) throw new Error("Kiro is not connected.");

    this.replaying = true;
    try {
      const result = await this.client.request(
        "session/load",
        { sessionId, cwd: this.workspaceRoot(), mcpServers: [] },
        30000
      );
      this.sessionId = sessionId;
      // Loading answers with the same model block a new session does — which
      // means it carries no credit rate either. Rebuilding the list from it
      // would drop the rates the picker shows, so ask for them again.
      if (result) {
        this.readModels(result);
        void this.enrichModels();
      }
      this.setStatus("ready");
    } finally {
      this.replaying = false;
    }
  }

  private setStatus(status: SessionStatus, detail?: string): void {
    this.status = status;
    this.events.onStatus(status, detail);
  }

  /**
   * Where Kiro runs. In a multi-root window the first folder remains its cwd,
   * but file access is allowed inside every folder the user opened.
   * With no folder open we fall back to the home directory rather
   * than process.cwd(), which for the extension host is wherever VS Code
   * itself was started — on Windows usually its own install folder.
   * `process.env.HOME` is no good here: Windows does not set it.
   */
  private workspaceRoot(): string {
    return this.workspaceRoots()[0];
  }

  private workspaceRoots(): string[] {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    return roots.length > 0 ? roots : [os.homedir()];
  }

  // One definition of containment, shared with the boundary check below, so
  // the two cannot drift into disagreeing about what "inside" means.
  private isInside(root: string, full: string): boolean {
    return isInsideRoot(root, full);
  }

  private displayPath(full: string): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const root = folder.uri.fsPath;
      if (!this.isInside(root, full)) continue;
      const relative = path.relative(root, full) || path.basename(full);
      if (folders.length === 1) return relative;
      return path.join(folder.name || path.basename(root), relative);
    }
    return path.basename(full);
  }

  async ensureReady(): Promise<void> {
    if (this.client?.isRunning && this.sessionId) return;
    if (this.starting) return this.starting;
    this.starting = this.startInternal().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startInternal(): Promise<void> {
    this.setStatus("starting");

    const config = vscode.workspace.getConfiguration("kiroChat");
    const configured = config.get<string>("command", "").trim();
    const env = config.get<Record<string, string>>("env", {});
    const allowWrites = config.get<boolean>("allowFileWrites", true);

    let command = configured;
    let extraArgs = config.get<string[]>("args", []);

    if (!command) {
      const found = await findKiro((line) => this.output.appendLine(line));
      if (!found) {
        this.setStatus("stopped");
        this.events.onNeedsSetup("missing");
        throw new Error("kiro-cli not found");
      }
      command = found.command;
      extraArgs = [...found.extraArgs, ...extraArgs];
    }

    this.client?.stop();
    this.client = new AcpClient({
      command,
      args: [...extraArgs, "acp"],
      cwd: this.workspaceRoot(),
      env,
      onLog: (line) => this.output.appendLine(line),
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (method, params) => this.handleRequest(method, params),
      onExit: () => {
        this.sessionId = undefined;
        this.setStatus("stopped");
      },
    });
    this.client.start();

    try {
      const init = await this.client.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: allowWrites },
          terminal: false,
        },
        clientInfo: { name: "vscode-kiro-chat", version: "0.3.0" },
      });
      this.output.appendLine(
        `Connected to ${init?.agentInfo?.name ?? "Kiro"} ${init?.agentInfo?.version ?? ""}`
      );

      this.supportsImages = Boolean(init?.agentCapabilities?.promptCapabilities?.image);
      this.supportsLoad = Boolean(init?.agentCapabilities?.loadSession);
      this.output.appendLine(`Past chats can be reopened: ${this.supportsLoad}`);
      this.output.appendLine(`Images accepted in prompts: ${this.supportsImages}`);
      this.events.onCapabilities({ image: this.supportsImages });

      const session = await this.client.request("session/new", {
        cwd: this.workspaceRoot(),
        mcpServers: [],
      });
      this.sessionId = session?.sessionId ?? session?.id;
      if (!this.sessionId) throw new Error("Kiro did not return a session id.");

      this.readModels(session);
      this.setStatus("ready");

      const saved = config.get<string>("model", "").trim();
      if (saved && saved !== this.currentModelId) {
        void this.setModel(saved, false);
      }

      // Credit rates come from a second call. Not worth blocking the panel on.
      void this.enrichModels();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("stopped");
      this.output.appendLine(`Failed to start "${command}": ${message}`);
      // Only blame the login when the error actually says so. This used to
      // report "signin" for every failure in here — a dropped pipe, a slow
      // spawn, a missing session id — which sent people off to log in again
      // when they were already signed in and hid what really broke.
      this.events.onNeedsSetup(looksLikeSignIn(message) ? "signin" : "failed", message);
      throw err;
    }
  }

  /**
   * Ask Kiro something. One conversation means one turn at a time.
   *
   * The busy check matters because this is reachable without passing the
   * webview's disabled Send button: `kiroChat.explainSelection` calls it
   * through the provider, so a right-click mid-turn would otherwise put a
   * second `session/prompt` on one session.
   */
  async send(blocks: ContentBlock[], options: SendOptions = {}): Promise<void> {
    // Read through the getter, as `runCommand` does: checking `this.status`
    // here narrows it for the rest of the method, and the `finally` below
    // legitimately expects it to be "busy" by then.
    if (this.currentStatus === "busy") {
      throw new Error("Kiro is still working on the last message. Wait for it to finish.");
    }
    await this.ensureReady();
    if (!this.client || !this.sessionId) return;

    const usable = this.supportsImages ? blocks : blocks.filter((b) => b.type !== "image");
    if (usable.length !== blocks.length) {
      this.events.onError("This version of Kiro cannot take images, so they were left out.");
    }

    this.turnReadOnly = options.readOnly === true;
    this.beginTurnFileCapture(usable);
    this.setStatus("busy");
    try {
      /*
       * Kiro's docs call this field `content`; the ACP spec calls it `prompt`.
       *
       * Deliberately sent with no timeout, unlike every other call that can
       * silently never answer. A turn is different in kind: an agentic run
       * editing several files legitimately takes as long as it takes, and any
       * threshold worth setting would eventually cut a real one short. Stop is
       * already there for a turn that has genuinely wedged, and that is the
       * user's judgement rather than a guess made here.
       */
      const result = await this.client.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: usable,
        content: usable,
      });
      await this.finishDirectFileReviews();
      this.reportTurnChanges();
      this.events.onTurnEnd(result?.stopReason);
    } catch (err) {
      // An edit can succeed before a later tool fails. It still needs to be
      // restored and reviewed instead of being left behind silently.
      await this.finishDirectFileReviews();
      this.reportTurnChanges();
      this.events.onError(err instanceof Error ? err.message : String(err));
      this.events.onTurnEnd("error");
    } finally {
      this.turnReadOnly = false;
      if (this.status === "busy") this.setStatus("ready");
    }
  }

  /**
   * Run one of Kiro's own commands — `usage`, `model` — and hand back what it
   * answered. This is the only route to the account credit picture and to the
   * per-model credit rates; neither is in plain ACP.
   *
   * The shape matters and is easy to get wrong. Kiro wants
   *
   *   { sessionId, command: { command: "usage", args: {} } }
   *
   * where `command` is an adjacently tagged enum. Passing the name as a plain
   * string, or as "/usage" with the slash, is rejected outright — which is why
   * the panel used to answer "Kiro would not report account usage here" every
   * single time. The names have no leading slash and are checked against the
   * list Kiro itself reports.
   */
  async runCommand(name: string, args: Record<string, unknown> = {}): Promise<CommandResult> {
    await this.ensureReady();
    if (!this.client || !this.sessionId) throw new Error("Kiro is not connected.");
    if (this.textSpy) throw new Error("A command is already running.");
    if (this.status === "busy") {
      throw new Error("Kiro is still working on the last message.");
    }

    // Some commands narrate through the normal stream. Catch that so it does
    // not land in the transcript as if the user had asked for it.
    let collected = "";
    this.textSpy = (text: string) => {
      collected += text;
    };

    this.setStatus("busy");
    try {
      const result = await this.client.request(
        "_kiro.dev/commands/execute",
        {
          sessionId: this.sessionId,
          command: { command: name.replace(/^\//, ""), args },
        },
        20000
      );
      const message = String(result?.message ?? "");
      return {
        ok: result?.success !== false,
        data: result?.data,
        text: (collected.trim() || contentToText(result?.content) || message).trim(),
      };
    } finally {
      this.textSpy = undefined;
      // Only hand the status back if the agent did not stop underneath us.
      if (this.currentStatus === "busy") this.setStatus("ready");
    }
  }

  /** Fold the numbers read out of a /usage report into the live usage. */
  mergeUsage(extra: Partial<UsageInfo>): UsageInfo {
    this.usage = { ...this.usage, ...extra };
    const snapshot = { ...this.usage };
    this.events.onUsage(snapshot);
    return snapshot;
  }

  cancel(): void {
    this.turnCancelled = true;
    this.changeReviewer.cancelPending();
    if (this.client?.isRunning && this.sessionId) {
      this.client.notify("session/cancel", { sessionId: this.sessionId });
    }
  }

  async newSession(): Promise<void> {
    this.turnCancelled = true;
    this.changeReviewer.cancelPending();
    this.sessionId = undefined;
    this.client?.stop();
    this.client = undefined;
    this.usage = {};
    this.events.onUsage({});
    this.setStatus("stopped");
    await this.ensureReady();
  }

  dispose(): void {
    this.changeReviewer.dispose();
    this.client?.stop();
    this.client = undefined;
    this.sessionId = undefined;
  }

  // ---- models ---------------------------------------------------------

  private readModels(session: any): void {
    const block = session?.models ?? session?.modelState;
    const list = block?.availableModels ?? block?.models ?? [];
    const raw = Array.isArray(list) ? list : [];

    // The exact shape varies between Kiro builds, and a missing credit rate is
    // otherwise invisible. Log it so the panel can be told what to read.
    this.output.appendLine(`Model list as Kiro sent it: ${JSON.stringify(raw)}`);

    this.models = raw
      .map((m: any) => ({
        modelId: String(m?.modelId ?? m?.id ?? ""),
        name: String(m?.name ?? m?.displayName ?? m?.modelId ?? m?.id ?? ""),
        description: m?.description ? String(m.description) : undefined,
        creditRate: creditRateOf(m),
      }))
      .filter((m: ModelInfo) => m.modelId);
    this.currentModelId = String(block?.currentModelId ?? this.models[0]?.modelId ?? "");
    this.output.appendLine(
      `Kiro offers ${this.models.length} model(s); current is "${this.currentModelId}".`
    );
    this.events.onModels(this.models, this.currentModelId);
  }

  /**
   * The model list that comes back with a new session carries no credit rate —
   * only the `model` command has `rateMultiplier` and the context window. Ask
   * for it once, so the picker can show what each model costs.
   */
  private async enrichModels(): Promise<void> {
    if (this.models.length === 0) return;
    try {
      const result = await this.runCommand("model");
      const details = readModelDetails(result.data);
      if (details.size === 0) {
        this.output.appendLine("The model command reported no credit rates.");
        return;
      }

      this.models = this.models.map((model) => {
        const extra = details.get(model.modelId);
        if (!extra) return model;
        return {
          ...model,
          creditRate: model.creditRate ?? extra.creditRate,
          contextWindow: describeContextWindow(extra.contextWindow),
        };
      });
      this.output.appendLine(`Credit rates read for ${details.size} model(s).`);
      this.events.onModels(this.models, this.currentModelId);
    } catch (err) {
      // Not fatal. The picker simply shows no rate, and says so.
      this.output.appendLine(
        `Could not read model credit rates: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  getModels(): { models: ModelInfo[]; currentModelId: string } {
    return { models: this.models, currentModelId: this.currentModelId };
  }

  getUsage(): UsageInfo {
    return { ...this.usage };
  }

  async setModel(modelId: string, remember = true): Promise<void> {
    if (!this.client?.isRunning || !this.sessionId) {
      throw new Error("Kiro is not connected yet.");
    }
    await this.client.request(
      "session/set_model",
      { sessionId: this.sessionId, modelId },
      10000
    );
    this.currentModelId = modelId;
    this.output.appendLine(`Model set to "${modelId}".`);
    if (remember) {
      await vscode.workspace
        .getConfiguration("kiroChat")
        .update("model", modelId, vscode.ConfigurationTarget.Global);
    }
    this.events.onModels(this.models, this.currentModelId);
  }

  // ---- messages coming from Kiro -------------------------------------

  private handleNotification(method: string, params: any): void {
    if (method === "_kiro.dev/metadata" || method === "kiro.dev/metadata") {
      this.readUsage(params);
      return;
    }
    if (!isSessionUpdate(method)) {
      this.output.appendLine(`[notify] ${method}`);
      return;
    }
    // A load may replay the whole conversation. The panel already has it
    // from its own store, so ignore the echo rather than paint it twice.
    if (this.replaying) return;

    const update = params?.update ?? params;

    // Some builds attach the meter to an ordinary update rather than sending a
    // metadata notification of its own. Reading both is what keeps the strip
    // from staying empty for a whole conversation.
    if (
      params?.contextUsagePercentage !== undefined ||
      params?.meteringUsage !== undefined
    ) {
      this.readUsage(params);
    } else if (
      update?.contextUsagePercentage !== undefined ||
      update?.meteringUsage !== undefined
    ) {
      this.readUsage(update);
    }
    const kind = normaliseKind(update?.sessionUpdate ?? update?.type ?? update?.kind);

    switch (kind) {
      case "agent_message_chunk": {
        const text = contentToText(update.content);
        // A command is collecting, or the panel is the audience.
        if (this.textSpy) this.textSpy(text);
        else this.events.onText(text);
        break;
      }
      case "agent_thought_chunk": {
        this.events.onThought(contentToText(update.content));
        break;
      }
      // `tool_call_chunk` is the first word that a step is starting, and it
      // arrives before `tool_call` has worked out a title. Ignoring it left
      // the panel saying only "Working…" for the whole of that gap.
      case "tool_call_chunk":
      case "tool_call":
      case "tool_call_update": {
        this.observeToolPaths(update);
        const tool = describeTool(update);
        this.output.appendLine(
          `[tool] ${tool.status} ${tool.title}${tool.purpose ? ` — ${tool.purpose}` : ""}`
        );
        this.events.onTool(tool);
        break;
      }
      case "turn_end":
        this.events.onTurnEnd(update.stopReason);
        break;
      default:
        this.output.appendLine(`[update] ${kind}`);
    }
  }

  /** Fold whatever a notification carried into the running totals. */
  private readUsage(params: any): void {
    this.usage = { ...this.usage, ...readMeter(params) };
    this.events.onUsage({ ...this.usage });
  }

  private async handleRequest(method: string, params: any): Promise<any> {
    switch (method) {
      case "fs/read_text_file":
      case "fs/readTextFile":
        return { content: await this.readFile(params) };
      case "fs/write_text_file":
      case "fs/writeTextFile":
        await this.writeFile(params);
        return null;
      case "session/request_permission":
        return this.askPermission(params);
      default:
        throw new Error(`Unsupported request: ${method}`);
    }
  }

  /**
   * The security boundary. Every path Kiro asks for goes through here — do not
   * route file access around it.
   *
   * Containment is tested against the *real* locations, not the paths as
   * written. Resolving the string defeats `../`, but it says nothing about a
   * symlink or a Windows junction inside the workspace pointing out of it:
   * that resolves to an in-workspace string and used to be accepted, which is
   * not what the README promises. `realPathOf` handles a file that does not
   * exist yet by resolving the nearest existing ancestor.
   *
   * The path handed back is still the one that was asked for, not its resolved
   * form, so a link inside the workspace keeps working as a link once it has
   * been shown to lead somewhere allowed.
   */
  private resolveInsideWorkspace(target: string): string {
    const full = path.resolve(this.workspaceRoot(), target);
    if (isInsideAnyRoot(this.workspaceRoots(), full)) return full;
    throw new Error(`Path is outside the open folders: ${target}`);
  }

  /*
   * Deliberately no size cap on what this will read.
   *
   * A large file is a memory spike at both ends, but a file Kiro asks for is
   * one it needs to answer the question it was given, and refusing at some
   * arbitrary threshold would fail the turn for a reason the user cannot see or
   * act on. Kiro already asks for `line`/`limit` when it only wants part of a
   * file, which is the mechanism that actually keeps these reads small.
   */
  private async readFile(params: any): Promise<string> {
    const full = this.resolveInsideWorkspace(String(params?.path ?? ""));
    const text = await fs.readFile(full, "utf8");
    const startLine = Number(params?.line ?? 0);
    const limit = params?.limit === undefined ? undefined : Number(params.limit);
    if (!startLine && limit === undefined) return text;
    const lines = text.split("\n");
    const from = startLine > 0 ? startLine - 1 : 0;
    return lines.slice(from, limit === undefined ? undefined : from + limit).join("\n");
  }

  private async writeFile(params: any): Promise<void> {
    if (this.turnReadOnly) {
      throw new Error("Plan mode is read-only. The proposed file edit was not applied.");
    }
    const allowWrites = vscode.workspace
      .getConfiguration("kiroChat")
      .get<boolean>("allowFileWrites", true);
    if (!allowWrites) {
      throw new Error("File writing is turned off in Kiro Chat settings.");
    }
    const full = this.resolveInsideWorkspace(String(params?.path ?? ""));
    this.clientReviewedPaths.add(this.pathKey(full));
    const proposed = String(params?.content ?? "");
    const before = await this.readExistingFile(full);

    // Do not interrupt the turn for a write that would change nothing.
    if (before.exists && before.content === proposed) return;

    let approved = proposed;
    const reviewWrites = vscode.workspace
      .getConfiguration("kiroChat")
      .get<boolean>("reviewFileWrites", true);
    const landed: AppliedState = {};
    if (reviewWrites) {
      const relative = this.displayPath(full);
      const decision = await this.changeReviewer.review({
        path: relative,
        sourcePath: full,
        before: before.content,
        after: proposed,
        creating: !before.exists,
        applyContent: this.createReviewApplier(full, before, landed),
      });
      this.answeredPaths.add(this.pathKey(full));
      if (!decision.accepted) {
        throw new Error(`Changes to ${relative} were rejected by the user.`);
      }
      approved = decision.content;

      // A review may be open for a while. Never overwrite typing, formatting,
      // or another tool's write that happened after the diff was calculated.
      const current = await this.readExistingFile(full);
      // Per-hunk acceptance writes through immediately. If the reviewer has
      // already produced the final content, there is nothing left to apply.
      if (current.exists && current.content === approved) return;
      // What the applier left is equally final, even when a formatter moved it
      // away from the accepted text on the way to disk.
      if (current.exists === landed.exists && current.content === landed.content) return;
      if (current.exists !== before.exists || current.content !== before.content) {
        throw new Error(
          `${relative} changed while its review was open. The approved changes were not applied.`
        );
      }
    }

    if (before.exists && before.content === approved) return;
    await this.writeFileContent(full, approved);
  }

  private async readExistingFile(
    full: string
  ): Promise<{ exists: boolean; content: string }> {
    try {
      return { exists: true, content: await fs.readFile(full, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { exists: false, content: "" };
      }
      throw err;
    }
  }

  /**
   * Write through VS Code rather than straight to disk, so the change lands on
   * the file's undo stack and Ctrl+Z puts it back.
   *
   * A raw `fs.writeFile` is invisible to the editor: the document quietly
   * reloads with no undo entry, which makes an accepted change permanent and
   * leaves the chat's own undo as the only way back. Anything the user can
   * accept they must be able to undo the ordinary way, in the file, where they
   * are already looking.
   *
   * Returns false if the edit could not be made that way — a file that is not
   * openable as text, or a rejected edit — so the caller can fall back to
   * writing it directly. A change on disk without undo still beats no change.
   */
  private async writeThroughEditor(full: string, content: string): Promise<boolean> {
    const uri = vscode.Uri.file(full);
    try {
      let document: vscode.TextDocument | undefined;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        document = undefined;
      }

      const edit = new vscode.WorkspaceEdit();
      if (document) {
        const end = document.positionAt(document.getText().length);
        edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), content);
      } else {
        edit.createFile(uri, { overwrite: true, contents: Buffer.from(content, "utf8") });
      }
      if (!(await vscode.workspace.applyEdit(edit))) return false;
      // applyEdit leaves the document dirty; the file on disk is what Kiro and
      // the rest of this class read back, so it has to be saved.
      if (document) await document.save();
      return true;
    } catch (err) {
      this.output.appendLine(
        `Could not write ${this.displayPath(full)} through the editor: ` +
          `${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }

  /** Write a file, preferring the undoable route. */
  private async writeFileContent(full: string, content: string): Promise<void> {
    if (await this.writeThroughEditor(full, content)) return;
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }

  /**
   * Apply accepted hunks as soon as their CodeLens action is clicked. Every
   * write is conditional on the exact state produced by the previous action,
   * so typing or another tool touching the file aborts instead of being lost.
   */
  private createReviewApplier(
    full: string,
    before: { exists: boolean; content: string },
    landed?: AppliedState
  ): (content: string, exists: boolean) => Promise<void> {
    let expected = { ...before };
    const record = (exists: boolean, content: string): void => {
      expected = { exists, content };
      if (landed) {
        landed.exists = exists;
        landed.content = content;
      }
    };
    return async (content, exists) => {
      const current = await this.readExistingFile(full);
      if (current.exists !== expected.exists || current.content !== expected.content) {
        throw new Error("The file changed outside the review.");
      }

      if (exists) {
        await this.writeFileContent(full, content);
        /*
         * Track the file, not the request.
         *
         * Writing through the editor means saving, and saving runs the save
         * participants — format-on-save among them — so what lands is not
         * necessarily byte for byte what was accepted. Recording the request
         * instead would make the next hunk look like somebody else editing
         * the file, and every decision after the first would be refused: the
         * review would never settle and the accepted change would never
         * arrive. Re-read and believe the disk.
         */
        const written = await this.readExistingFile(full);
        record(written.exists, written.content);
        return;
      }

      try {
        await fs.unlink(full);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
      }
      record(false, "");
    };
  }

  /**
   * Kiro CLI 2.21 performs its built-in FileWrite tools itself, even though
   * this ACP client advertises fs/write_text_file. Snapshot attached files at
   * the start of the turn, then add any other path as soon as its tool call is
   * announced. This gives the review flow the real pre-edit content.
   */
  private beginTurnFileCapture(blocks: ContentBlock[]): void {
    this.turnBaselines.clear();
    this.directFileChanges.clear();
    this.toolTouchedPaths.clear();
    this.observedWriteTools.clear();
    this.clientReviewedPaths.clear();
    this.answeredPaths.clear();
    this.turnCancelled = false;

    for (const block of blocks) {
      if (block.type !== "resource_link") continue;
      try {
        const uri = vscode.Uri.parse(block.uri);
        if (uri.scheme !== "file") continue;
        const full = this.resolveInsideWorkspace(uri.fsPath);
        this.captureBaseline(full);
      } catch {
        // A resource outside the workspace is never writable through this
        // extension and does not belong in the turn's change set.
      }
    }
  }

  private pathKey(full: string): string {
    const normal = path.normalize(full);
    return process.platform === "win32" ? normal.toLowerCase() : normal;
  }

  /**
   * A pre-turn copy of one file, or undefined when there is nothing usable.
   *
   * Anything that is not simply a missing file — an unreadable path, a
   * directory, something implausibly large — comes back undefined rather than
   * throwing. A baseline that could not be taken is not the same as a file
   * that does not exist, and recording it as the latter would put a wrong
   * entry in the undo set. Throwing was worse still: baselines are now taken
   * for every file a tool mentions, so one unreadable path would have taken
   * `reportTurnChanges` down with it and lost the whole keep-or-undo card.
   */
  private snapshotSync(full: string): FileSnapshot | undefined {
    try {
      const stat = fsSync.statSync(full);
      if (!stat.isFile()) return undefined;
      if (stat.size > MAX_BASELINE_BYTES) {
        this.output.appendLine(
          `Not snapshotting ${this.displayPath(full)}: ${stat.size} bytes is past the limit.`
        );
        return undefined;
      }
      return { full, exists: true, content: fsSync.readFileSync(full, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { full, exists: false, content: "" };
      }
      this.output.appendLine(
        `Could not snapshot ${this.displayPath(full)}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return undefined;
    }
  }

  private captureBaseline(full: string): FileSnapshot | undefined {
    const key = this.pathKey(full);
    const saved = this.turnBaselines.get(key);
    if (saved) return saved;
    const snapshot = this.snapshotSync(full);
    if (snapshot) this.turnBaselines.set(key, snapshot);
    return snapshot;
  }

  /**
   * Every workspace path a tool update mentions, however it names them.
   *
   * Kiro puts a path in more places than one, and reading only `rawInput.path`
   * missed most of them. The payload captured in `test/toolSteps.test.js` for
   * a single read carries the path twice — once in `locations`, once in
   * `rawInput.operations[].path` — and in neither of the places this used to
   * look. A path that is never found is a file that is never snapshotted, and
   * therefore never reviewed.
   */
  private pathsMentionedBy(update: any): string[] {
    const raw = update?.rawInput ?? update?.input ?? update?.toolCall?.rawInput;
    const locations = (value: any) =>
      Array.isArray(value) ? value.map((entry: any) => entry?.path) : [];

    const candidates: unknown[] = [
      raw?.path,
      raw?.filePath,
      raw?.file_path,
      ...locations(update?.locations),
      ...locations(update?.toolCall?.locations),
      ...locations(raw?.operations),
    ];

    const out: string[] = [];
    for (const value of candidates) {
      if (typeof value !== "string" || !value) continue;
      try {
        const full = this.resolveInsideWorkspace(value);
        if (!out.includes(full)) out.push(full);
      } catch {
        // Outside the open folders, so never writable through this extension
        // and not part of the turn's change set.
      }
    }
    return out;
  }

  /**
   * Watch a tool update for the files it is about.
   *
   * Two jobs, and they used to be one:
   *
   * - **Every** path any tool mentions gets a pre-turn snapshot, whatever the
   *   tool is. Reading a file is the strongest available hint that an edit is
   *   coming, and a snapshot is worth nothing unless it was taken first.
   * - A tool that *looks* like a write additionally gets its result simulated,
   *   so `finishDirectFileReviews` has something to compare against.
   *
   * `isWriteLikeTool` used to gate both, which made it the only thing standing
   * between an edit and going unreviewed: a tool shape it did not recognise —
   * or a path it could not find, which for the `operations` form was every
   * time — meant no snapshot, no diff, and no keep-or-undo card. The edit
   * simply appeared on disk. It is a hint now, the same demotion
   * `DirectFileChange.expected` already went through, and for the same reason:
   * an unreviewed edit is the one outcome nobody wants.
   */
  private observeToolPaths(update: any): void {
    /*
     * Snapshot everything; only offer a diff for what might have been written.
     *
     * The snapshot is taken either way — it costs a read, and a later
     * unrecognised write to the same file needs a "before" that predates it.
     * What a read does not earn is a *review*. 0.25.0 reviewed any snapshotted
     * file that differed at the end of the turn, which meant a file Kiro merely
     * read could open a diff when something outside Kiro — a watcher, a
     * formatter, a dev server — rewrote it mid-turn, and rejecting that diff
     * would clobber a write Kiro never made.
     *
     * `isReadOnlyTool` answers false for anything it does not recognise, so an
     * unknown tool still earns a review. Only a kind that positively cannot
     * write opts out, and the change still reaches the keep-or-undo card,
     * which is the gentler surface for "this changed, was that you?".
     */
    const reviewable = !isReadOnlyTool(update);
    for (const full of this.pathsMentionedBy(update)) {
      if (!this.captureBaseline(full)) continue;
      if (reviewable) this.toolTouchedPaths.add(this.pathKey(full));
    }

    // Shared with askPermission, which uses the same answer to decide that an
    // edit does not need a prompt of its own. Two copies of this heuristic
    // would eventually disagree, and the symptom would be a stray prompt.
    if (!isWriteLikeTool(update)) return;

    const raw = update?.rawInput ?? update?.input ?? update?.toolCall?.rawInput;
    const target = raw?.path ?? raw?.filePath ?? raw?.file_path;
    // The named target when there is one, otherwise whatever the update
    // mentioned first — a write that only reports `locations` still has a file.
    const full =
      typeof target === "string" && target
        ? this.pathsMentionedBy({ rawInput: { path: target } })[0]
        : this.pathsMentionedBy(update)[0];
    if (!full) return;

    const toolId = String(update?.toolCallId ?? update?.id ?? "");
    if (toolId && this.observedWriteTools.has(toolId)) return;

    const key = this.pathKey(full);
    const before = this.captureBaseline(full);
    if (!before) return;
    const tracked = this.directFileChanges.get(key) ?? { before };
    const base = tracked.expected ?? before.content;
    const expected = this.expectedToolResult(base, raw);
    if (expected !== undefined) tracked.expected = expected;
    this.directFileChanges.set(key, tracked);
    this.output.appendLine(`Captured Kiro's built-in write to ${this.displayPath(full)}.`);
    if (toolId && raw) this.observedWriteTools.add(toolId);
  }

  private expectedToolResult(base: string, raw: any): string | undefined {
    const command = String(raw?.command ?? raw?.mode ?? "").toLowerCase();
    if (["strreplace", "replace"].includes(command)) {
      const oldText = raw?.oldStr ?? raw?.old_string ?? raw?.oldText;
      const newText = raw?.newStr ?? raw?.new_string ?? raw?.newText;
      if (typeof oldText !== "string" || typeof newText !== "string" || !base.includes(oldText)) {
        return undefined;
      }
      return raw?.replaceAll ? base.split(oldText).join(newText) : base.replace(oldText, newText);
    }

    const content = raw?.content ?? raw?.newContent ?? raw?.new_content;
    if (["write", "create", "overwrite"].includes(command) && typeof content === "string") {
      return content;
    }
    return undefined;
  }

  /**
   * Put Kiro's direct writes back to their pre-turn state, then feed the final
   * versions through the same selectable reviewer as an ACP callback write.
   */
  private async finishDirectFileReviews(): Promise<void> {
    /*
     * Everything a tool touched, not only what looked like a write.
     *
     * This used to walk `directFileChanges` alone, so the review a file got
     * depended entirely on `isWriteLikeTool` having recognised the tool that
     * wrote it. Walking every snapshotted path a tool mentioned and comparing
     * it against disk asks a better question — "did this actually change?" —
     * which needs no heuristic to be right. `directFileChanges` now only
     * supplies the simulated result, and that was always just a hint.
     *
     * Baselines from attached files are deliberately not included: they were
     * snapshotted because the user attached them, not because Kiro touched
     * them, and a file the *user* edited mid-turn must not be handed back as a
     * diff offering to undo their own work.
     */
    const candidates = new Map<string, DirectFileChange>();
    for (const key of this.toolTouchedPaths) {
      const before = this.turnBaselines.get(key);
      if (before) candidates.set(key, { before });
    }
    for (const [key, tracked] of this.directFileChanges) candidates.set(key, tracked);

    this.directFileChanges.clear();
    this.toolTouchedPaths.clear();
    if (candidates.size === 0) return;
    const changes = [...candidates.entries()];

    const config = vscode.workspace.getConfiguration("kiroChat");
    const writesEnabled = config.get<boolean>("allowFileWrites", true);
    const allowWrites = writesEnabled && !this.turnReadOnly;
    const reviewWrites = config.get<boolean>("reviewFileWrites", true);

    for (const [key, tracked] of changes) {
      if (this.clientReviewedPaths.has(key)) continue;
      const current = await this.readExistingFile(tracked.before.full);
      if (
        current.exists === tracked.before.exists &&
        current.content === tracked.before.content
      ) {
        continue;
      }

      const relative = this.displayPath(tracked.before.full);

      /*
       * `expected` is a simulation of what Kiro's tool input should produce,
       * chained across every edit to this file in the turn. It used to have to
       * match the file byte for byte or the review was abandoned.
       *
       * That was backwards. The simulation drifts for entirely ordinary
       * reasons — several edits to one file, a replace the simulation models
       * differently from Kiro — and when it drifted the review was skipped
       * while Kiro's edit stayed on disk. The one outcome nobody wants is an
       * unreviewed edit, and that is precisely what it produced.
       *
       * The review does not need the prediction to be right. It shows what is
       * on disk now against the pre-turn snapshot and lets the user decide, so
       * a surprise is something they see rather than something that is applied
       * behind a warning. The mismatch is still worth logging.
       */
      if (tracked.expected !== undefined && current.content !== tracked.expected) {
        this.output.appendLine(
          `${relative} does not match the simulated result of Kiro's edit. ` +
            "Reviewing what is actually on disk instead."
        );
      }

      if (!reviewWrites && allowWrites && !this.turnCancelled) continue;
      await this.restoreSnapshot(tracked.before);

      if (this.turnCancelled) {
        this.output.appendLine(`Reverted Kiro's cancelled change to ${relative}.`);
        continue;
      }
      if (!allowWrites) {
        const message = this.turnReadOnly
          ? `Kiro tried to edit ${relative} in Plan mode. The edit was reverted.`
          : `Kiro tried to edit ${relative}, but file writing is turned off. The edit was reverted.`;
        this.output.appendLine(message);
        this.events.onError(message);
        continue;
      }

      const landed: AppliedState = {};
      const decision = await this.changeReviewer.review({
        path: relative,
        sourcePath: tracked.before.full,
        before: tracked.before.content,
        after: current.content,
        creating: !tracked.before.exists,
        applyContent: this.createReviewApplier(
          tracked.before.full,
          { exists: tracked.before.exists, content: tracked.before.content },
          landed
        ),
      });
      this.answeredPaths.add(key);
      if (!decision.accepted) {
        this.output.appendLine(`Kept the original ${relative}.`);
        continue;
      }

      const now = await this.readExistingFile(tracked.before.full);
      if (now.exists && now.content === decision.content) continue;
      // A formatter running on save leaves the file final but not identical to
      // the accepted text. That is the applier's work, not an outside edit.
      if (now.exists === landed.exists && now.content === landed.content) continue;
      if (now.exists !== tracked.before.exists || now.content !== tracked.before.content) {
        const message = `${relative} changed while its review was open. The approved lines were not applied.`;
        this.output.appendLine(message);
        this.events.onError(message);
        continue;
      }
      if (tracked.before.exists && decision.content === tracked.before.content) continue;
      await this.writeFileContent(tracked.before.full, decision.content);
    }
  }

  /**
   * Tell the chat what the turn actually changed, so it can offer to keep or
   * undo the lot.
   *
   * Compared against the pre-turn snapshots rather than assumed from what Kiro
   * said it would do: a rejected review restores the original, and Kiro
   * sometimes rewrites a file with what it already held. Neither is a change,
   * and offering to undo one would be offering to undo nothing.
   */
  private reportTurnChanges(): void {
    if (!this.events.onTurnChanges) return;

    const baselines = [...this.turnBaselines.values()];
    const changes = changedSinceBaseline(baselines, (full) => this.snapshotSync(full))
      // Anything decided hunk by hunk in the diff has already been answered.
      .filter((change) => !this.answeredPaths.has(this.pathKey(change.path)))
      .map((change) => ({
        ...change,
        label: vscode.workspace.asRelativePath(change.path),
      }));

    // Keep only the snapshots we might have to put back.
    const changedPaths = new Set(changes.map((change) => this.pathKey(change.path)));
    this.lastTurnBaselines = baselines.filter((snapshot) =>
      changedPaths.has(this.pathKey(snapshot.full))
    );

    if (changes.length === 0) return;
    this.output.appendLine(
      `Turn changed ${changes.length} file(s): ${changes.map((c) => c.label).join(", ")}.`
    );
    this.events.onTurnChanges({ text: describeChange(changes), files: changes });
  }

  /**
   * Put every file the last turn changed back as it was. Used by the chat's
   * "Undo all" once the user has seen what happened.
   */
  async undoLastTurn(): Promise<number> {
    const snapshots = this.lastTurnBaselines;
    this.lastTurnBaselines = [];
    let restored = 0;

    for (const snapshot of snapshots) {
      try {
        await this.restoreSnapshot(snapshot);
        restored++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`Could not undo ${snapshot.full}: ${message}`);
        this.events.onError(`Could not undo ${snapshot.full}: ${message}`);
      }
    }
    this.output.appendLine(`Undid ${restored} of ${snapshots.length} changed file(s).`);
    return restored;
  }

  /** Accept every pending hunk of the review on screen. */
  acceptActiveReview(): Promise<void> {
    return this.changeReviewer.acceptActive();
  }

  /** Reject the review on screen, restoring the original file. */
  rejectActiveReview(): Promise<void> {
    return this.changeReviewer.rejectActive();
  }

  /**
   * Jump to the next undecided change.
   *
   * The chat panel needs this as well as the editor: the diff is often behind
   * the chat, and from there the user cannot reach a keybinding that only
   * fires while the review has focus.
   */
  gotoNextChange(): Promise<void> {
    return this.changeReviewer.gotoNext();
  }

  /** The user kept the changes; there is nothing left to put back. */
  keepLastTurn(): void {
    this.lastTurnBaselines = [];
  }

  /*
   * Restoring stays on the raw disk write, unlike an accepted change.
   *
   * Putting a file back is not an edit the user made, and it has to be exact.
   * Going through the editor would save it, and saving runs format-on-save —
   * so rejecting a change could leave the file reformatted rather than as it
   * was. An accepted change is the opposite case: there the formatter is
   * welcome, because that is what saving the same edit by hand would do.
   */
  private async restoreSnapshot(snapshot: FileSnapshot): Promise<void> {
    if (snapshot.exists) {
      await fs.mkdir(path.dirname(snapshot.full), { recursive: true });
      await fs.writeFile(snapshot.full, snapshot.content, "utf8");
      return;
    }
    try {
      await fs.unlink(snapshot.full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }

  private async askPermission(params: any): Promise<any> {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const config = vscode.workspace.getConfiguration("kiroChat");
    const autoApprove = config.get<boolean>("autoApproveTools", false);

    if (options.length === 0) return { outcome: { outcome: "cancelled" } };

    /*
     * Prefer the narrowest grant Kiro offered.
     *
     * ACP sends allow_once and allow_always side by side, and taking whichever
     * arrived first meant an auto-approval could hand out a standing
     * permission when a single-use one was on the table. Nothing here should
     * grant more than the moment needs.
     */
    const allowOption = () => {
      const kindOf = (option: any) =>
        String(option?.kind ?? "").replace(/[-\s]/g, "_").toLowerCase();
      return (
        options.find((option) => kindOf(option) === "allow_once") ??
        options.find((option) => kindOf(option).startsWith("allow")) ??
        options[0]
      );
    };

    if (autoApprove) {
      const allow = allowOption();
      // The other branch that answers without asking writes down that it did.
      // This one did not, so with `autoApproveTools` on there was no record
      // anywhere — not the panel, not the log — that a permission had been
      // granted at all.
      this.output.appendLine(
        `Auto-approved (kiroChat.autoApproveTools): ` +
          `${String(params?.toolCall?.title ?? params?.toolCall?.kind ?? "a tool")} ` +
          `— chose "${String(allow?.name ?? allow?.optionId ?? allow?.id)}"`
      );
      return { outcome: { outcome: "selected", optionId: allow.optionId ?? allow.id } };
    }

    /*
     * An edit gets one gate, not two.
     *
     * Asking "may I write this file?" and then opening a diff that asks
     * "keep these changes?" is the same question twice, and the first one is
     * the useless one: it is asked before there is anything to look at. The
     * review is where the user can actually see what is proposed, so when it
     * is going to open, let the edit through and let the diff do the asking.
     *
     * Only when the review will really open. With review off, or writing off,
     * or in a read-only workflow, this prompt is the only gate there is.
     */
    const reviewWillOpen =
      config.get<boolean>("reviewFileWrites", true) &&
      config.get<boolean>("allowFileWrites", true) &&
      !this.turnReadOnly;

    /*
     * Unless the user has asked for both, which is a fair thing to want.
     *
     * The one-gate rule above is about not asking the same question twice —
     * but the two questions are not quite the same. Kiro CLI 2.21 writes files
     * itself, so the review can only put a file back after the fact: anything
     * watching the filesystem has already seen the write. This prompt is the
     * only gate that can stop one reaching disk. Defaulting to a single gate
     * keeps a ten-edit turn from becoming twenty prompts; `askBeforeEdits`
     * exists because "stop it before it happens" is a different need from
     * "let me read it afterwards", and only the user knows which they have.
     */
    const askAnyway = config.get<boolean>("askBeforeEdits", false);

    if (!askAnyway && reviewWillOpen && isWriteLikeTool(params?.toolCall ?? params)) {
      const allow = allowOption();
      this.output.appendLine(
        `Letting an edit through without a prompt; the review diff is the gate: ` +
          `${String(params?.toolCall?.title ?? params?.toolCall?.kind ?? "edit")}`
      );
      return { outcome: { outcome: "selected", optionId: allow.optionId ?? allow.id } };
    }

    const title = String(params?.toolCall?.title ?? params?.toolCall?.kind ?? "run a tool");
    const choices = options.map((option) => ({
      id: String(option.optionId ?? option.id),
      label: String(option.name ?? option.optionId ?? option.id),
      kind: String(option.kind ?? ""),
    }));
    let pickedId: string | undefined;
    if (this.events.onPermission) {
      pickedId = await this.events.onPermission({ title, options: choices });
    } else {
      // The chat view normally owns this interaction. Keep a non-modal
      // fallback for callers that run Kiro without resolving the panel.
      const label = await vscode.window.showInformationMessage(
        `Kiro wants to ${title}.`,
        ...choices.map((choice) => choice.label)
      );
      pickedId = choices.find((choice) => choice.label === label)?.id;
    }

    if (!pickedId) return { outcome: { outcome: "cancelled" } };
    const chosen = options.find(
      (option) => String(option.optionId ?? option.id) === pickedId
    );
    if (!chosen) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: chosen.optionId ?? chosen.id } };
  }
}
