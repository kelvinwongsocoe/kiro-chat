import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { AcpClient } from "./acpClient";
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

  constructor(
    private readonly output: vscode.OutputChannel,
    private readonly events: SessionEvents
  ) {}

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
   * Where Kiro runs, and the boundary every file read and write is checked
   * against. With no folder open we fall back to the home directory rather
   * than process.cwd(), which for the extension host is wherever VS Code
   * itself was started — on Windows usually its own install folder.
   * `process.env.HOME` is no good here: Windows does not set it.
   */
  private workspaceRoot(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
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

  async send(blocks: ContentBlock[]): Promise<void> {
    await this.ensureReady();
    if (!this.client || !this.sessionId) return;

    const usable = this.supportsImages ? blocks : blocks.filter((b) => b.type !== "image");
    if (usable.length !== blocks.length) {
      this.events.onError("This version of Kiro cannot take images, so they were left out.");
    }

    this.setStatus("busy");
    try {
      // Kiro's docs call this field `content`; the ACP spec calls it `prompt`.
      const result = await this.client.request("session/prompt", {
        sessionId: this.sessionId,
        prompt: usable,
        content: usable,
      });
      // A sink means someone else asked and is showing the answer; the panel
      // must not also declare the turn over, and the error belongs to the
      // caller rather than to the transcript.
      if (!this.sink) this.events.onTurnEnd(result?.stopReason);
    } catch (err) {
      if (this.sink) throw err;
      this.events.onError(err instanceof Error ? err.message : String(err));
      this.events.onTurnEnd("error");
    } finally {
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
    if (this.client?.isRunning && this.sessionId) {
      this.client.notify("session/cancel", { sessionId: this.sessionId });
    }
  }

  async newSession(): Promise<void> {
    this.sessionId = undefined;
    this.client?.stop();
    this.client = undefined;
    this.usage = {};
    this.events.onUsage({});
    this.setStatus("stopped");
    await this.ensureReady();
  }

  dispose(): void {
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
    const root = this.workspaceRoot();
    const full = path.resolve(root, target);
    const relative = path.relative(root, full);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Path is outside the open folder: ${target}`);
    }
    return full;
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
    const allowWrites = vscode.workspace
      .getConfiguration("kiroChat")
      .get<boolean>("allowFileWrites", true);
    if (!allowWrites) {
      throw new Error("File writing is turned off in Kiro Chat settings.");
    }
    const full = this.resolveInsideWorkspace(String(params?.path ?? ""));
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, String(params?.content ?? ""), "utf8");
  }

  private async askPermission(params: any): Promise<any> {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const autoApprove = vscode.workspace
      .getConfiguration("kiroChat")
      .get<boolean>("autoApproveTools", false);

    if (options.length === 0) return { outcome: { outcome: "cancelled" } };

    if (autoApprove) {
      const allow =
        options.find((o) => String(o.kind ?? "").startsWith("allow")) ?? options[0];
      return { outcome: { outcome: "selected", optionId: allow.optionId ?? allow.id } };
    }

    const title = params?.toolCall?.title ?? params?.toolCall?.kind ?? "run a tool";
    const labels = options.map((o) => String(o.name ?? o.optionId ?? o.id));
    const picked = await vscode.window.showInformationMessage(
      `Kiro wants to ${title}.`,
      { modal: true },
      ...labels
    );

    if (!picked) return { outcome: { outcome: "cancelled" } };
    const chosen = options[labels.indexOf(picked)];
    return { outcome: { outcome: "selected", optionId: chosen.optionId ?? chosen.id } };
  }
}
