import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import { AcpClient } from "./acpClient";
import { ActiveReviewInfo, ChangeReviewer } from "./changeReviewer";
import { isWriteLikeTool } from "./writeTools";
import { changedSinceBaseline, describeChange, TurnChange } from "./turnChanges";
import { findKiro } from "./findKiro";
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

/** Somewhere other than the panel for one turn's output to go. */
export interface TurnSink {
  onText: (text: string) => void;
  onThought?: (text: string) => void;
  onTool?: (tool: { id: string; title: string; status: string }) => void;
}

export interface SendOptions {
  /** Refuse and restore all writes made during this turn. */
  readOnly?: boolean;
}

export interface SessionEvents {
  onStatus: (status: SessionStatus, detail?: string) => void;
  onText: (text: string) => void;
  onThought: (text: string) => void;
  onTool: (tool: { id: string; title: string; status: string }) => void;
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
  /**
   * Where this turn's output goes, when it is not the panel. VS Code's own
   * chat box asks through `sendTo`, and its answer belongs in its response
   * stream rather than in the webview's transcript.
   */
  private sink: TurnSink | undefined;
  private readonly changeReviewer: ChangeReviewer;
  /** Baselines are captured before Kiro's built-in tools can touch disk. */
  private readonly turnBaselines = new Map<string, FileSnapshot>();
  private readonly directFileChanges = new Map<string, DirectFileChange>();
  private readonly observedWriteTools = new Set<string>();
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

  private isInside(root: string, full: string): boolean {
    const relative = path.relative(root, full);
    return (
      relative === "" ||
      (relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative))
    );
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
   * Ask Kiro something on behalf of VS Code's own chat box, streaming the
   * answer into the caller's sink instead of the panel's transcript.
   *
   * The two share one Kiro session deliberately: the conversation is the same
   * conversation whichever box it was typed into, so credits, context and
   * memory all stay in one place rather than running a second agent.
   */
  async sendTo(blocks: ContentBlock[], sink: TurnSink): Promise<void> {
    if (this.sink) throw new Error("Kiro is already answering another question.");
    if (this.status === "busy") {
      throw new Error("Kiro is still working on the last message. Wait for it to finish.");
    }
    this.sink = sink;
    try {
      await this.send(blocks);
    } finally {
      this.sink = undefined;
    }
  }

  async send(blocks: ContentBlock[], options: SendOptions = {}): Promise<void> {
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
      // Kiro's docs call this field `content`; the ACP spec calls it `prompt`.
      const result = await this.client.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: usable,
        content: usable,
      });
      await this.finishDirectFileReviews();
      this.reportTurnChanges();
      // A sink means someone else asked and is showing the answer; the panel
      // must not also declare the turn over, and the error belongs to the
      // caller rather than to the transcript.
      if (!this.sink) this.events.onTurnEnd(result?.stopReason);
    } catch (err) {
      // An edit can succeed before a later tool fails. It still needs to be
      // restored and reviewed instead of being left behind silently.
      await this.finishDirectFileReviews();
      this.reportTurnChanges();
      if (this.sink) throw err;
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
    if (method !== "session/update" && method !== "session/notification") {
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
        // A command is collecting, a chat participant is streaming, or the
        // panel is the audience — in that order of precedence.
        if (this.textSpy) this.textSpy(text);
        else if (this.sink) this.sink.onText(text);
        else this.events.onText(text);
        break;
      }
      case "agent_thought_chunk": {
        const thought = contentToText(update.content);
        if (this.sink) this.sink.onThought?.(thought);
        else this.events.onThought(thought);
        break;
      }
      case "tool_call":
      case "tool_call_update": {
        this.observeDirectFileWrite(update);
        const tool = {
          id: String(update.toolCallId ?? update.id ?? Math.random()),
          title: String(update.title ?? update.rawInput?.command ?? update.kind ?? "tool"),
          status: String(update.status ?? "running"),
        };
        if (this.sink) this.sink.onTool?.(tool);
        else this.events.onTool(tool);
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

  private resolveInsideWorkspace(target: string): string {
    const full = path.resolve(this.workspaceRoot(), target);
    if (this.workspaceRoots().some((root) => this.isInside(root, full))) return full;
    throw new Error(`Path is outside the open folders: ${target}`);
  }

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

  private snapshotSync(full: string): FileSnapshot {
    try {
      return { full, exists: true, content: fsSync.readFileSync(full, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return { full, exists: false, content: "" };
      }
      throw err;
    }
  }

  private captureBaseline(full: string): FileSnapshot {
    const key = this.pathKey(full);
    const saved = this.turnBaselines.get(key);
    if (saved) return saved;
    const snapshot = this.snapshotSync(full);
    this.turnBaselines.set(key, snapshot);
    return snapshot;
  }

  /** Record the path and expected content from a built-in edit tool update. */
  private observeDirectFileWrite(update: any): void {
    // Shared with askPermission, which uses the same answer to decide that an
    // edit does not need a prompt of its own. Two copies of this heuristic
    // would eventually disagree, and the symptom would be a stray prompt.
    if (!isWriteLikeTool(update)) return;

    const raw = update?.rawInput ?? update?.input ?? update?.toolCall?.rawInput;

    const target = raw?.path ?? raw?.filePath ?? raw?.file_path;
    if (typeof target !== "string" || !target) return;

    let full: string;
    try {
      full = this.resolveInsideWorkspace(target);
    } catch (err) {
      this.output.appendLine(
        `Ignored a write tool outside the workspace: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
      return;
    }

    const toolId = String(update?.toolCallId ?? update?.id ?? "");
    if (toolId && this.observedWriteTools.has(toolId)) return;

    const key = this.pathKey(full);
    const before = this.captureBaseline(full);
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
    if (this.directFileChanges.size === 0) return;
    const changes = [...this.directFileChanges.entries()];
    this.directFileChanges.clear();

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

    const allowOption = () =>
      options.find((o) => String(o.kind ?? "").startsWith("allow")) ?? options[0];

    if (autoApprove) {
      const allow = allowOption();
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

    if (reviewWillOpen && isWriteLikeTool(params?.toolCall ?? params)) {
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
