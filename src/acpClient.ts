import { spawn, ChildProcess } from "node:child_process";

/**
 * A very small JSON-RPC 2.0 client that speaks to `kiro-cli acp`
 * over the child process's stdin/stdout, one JSON object per line.
 *
 * Kiro can also send requests back to us (to read a file, to ask
 * permission to run a tool), so this is two-way, not just request/reply.
 */

export type RequestHandler = (method: string, params: any) => Promise<any>;

export interface AcpClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onNotification: (method: string, params: any) => void;
  onRequest: RequestHandler;
  onLog: (line: string) => void;
  onExit: (code: number | null, signal: string | null) => void;
}

/** True for the batch shims that Node will not spawn directly. */
export function needsShell(command: string): boolean {
  return /\.(cmd|bat)$/i.test(command.trim());
}

/** Wrap in double quotes for cmd.exe when there is anything to protect. */
export function quote(value: string): string {
  if (!value || /^".*"$/.test(value)) return value;
  return /[\s&|<>^()]/.test(value) ? `"${value}"` : value;
}

/**
 * How to kill what `start` actually spawned.
 *
 * A `.cmd` or `.bat` shim is run through the shell, so the child this class
 * holds is cmd.exe and `kiro-cli` is its *grandchild*. `proc.kill()` reaches
 * only the shell, leaving the real agent running — and with it the ACP session
 * and its lock on the workspace. Restarting the agent a few times that way
 * leaves a trail of live kiro-cli processes behind.
 *
 * Windows has no process group to signal, so the whole tree goes through
 * taskkill. Returns undefined whenever an ordinary kill() is the right thing:
 * a real .exe we spawned directly, or any other platform.
 */
export function killArgs(
  pid: number | undefined,
  viaShell: boolean,
  platform: string = process.platform
): string[] | undefined {
  if (!viaShell || platform !== "win32") return undefined;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return undefined;
  return ["/pid", String(pid), "/t", "/f"];
}

/**
 * How much *unterminated* stdout to hold on to.
 *
 * A line is only dispatched once its newline arrives, so anything without one
 * accumulates with no bound. A real ACP message is nowhere near this size;
 * something emitting megabytes of it is malfunctioning, and holding the lot
 * turns that malfunction into a memory problem as well. Checked after the line
 * loop has run, so a large write full of *complete* messages is never dropped —
 * only a trailing fragment that has grown implausible.
 */
const MAX_PENDING_STDOUT = 1024 * 1024;

interface Pending {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer?: NodeJS.Timeout;
}

export class AcpClient {
  private proc: ChildProcess | undefined;
  private stdoutBuffer = "";
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stopped = false;
  /** Whether the running child is a shell wrapping the real agent. */
  private viaShell = false;

  constructor(private readonly options: AcpClientOptions) {}

  get isRunning(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.stopped;
  }

  start(): void {
    if (this.isRunning) {
      return;
    }
    this.stopped = false;
    this.stdoutBuffer = "";

    const { command, args, cwd, env } = this.options;
    this.options.onLog(`Starting: ${command} ${args.join(" ")}`);

    // Windows installers often ship the CLI as a .cmd or .bat shim, and since
    // Node 20 spawning one without a shell throws a bare EINVAL. Route those
    // through the shell, quoting so a path with spaces still works.
    // Build one quoted command line for the shell case. Node warns when args
    // are passed alongside shell: true, because it does not escape them.
    const viaShell = needsShell(command);
    this.viaShell = viaShell;
    const proc = spawn(
      viaShell ? [command, ...args].map(quote).join(" ") : command,
      viaShell ? [] : args,
      {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["pipe", "pipe", "pipe"],
        shell: viaShell,
        // Otherwise a console window flashes up on every start.
        windowsHide: true,
      }
    );
    this.proc = proc;

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => this.consume(chunk));

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      this.options.onLog(`[kiro stderr] ${chunk.trimEnd()}`);
    });

    proc.on("error", (err) => {
      this.options.onLog(`Could not start Kiro: ${err.message}`);
      this.failAllPending(new Error(`Could not start "${command}": ${err.message}`));
      this.proc = undefined;
      this.options.onExit(null, null);
    });

    proc.on("exit", (code, signal) => {
      this.options.onLog(`Kiro exited (code ${code ?? "none"}, signal ${signal ?? "none"}).`);
      this.failAllPending(new Error("The Kiro agent stopped running."));
      this.proc = undefined;
      this.options.onExit(code, signal);
    });
  }

  stop(): void {
    this.stopped = true;
    this.failAllPending(new Error("The Kiro agent was stopped."));
    const proc = this.proc;
    if (!proc) return;
    this.proc = undefined;
    proc.stdin?.end();

    const args = killArgs(proc.pid, this.viaShell);
    if (!args) {
      proc.kill();
      return;
    }
    // taskkill /t takes the shell and everything underneath it, which is the
    // only way to reach the agent when a .cmd shim is in between.
    try {
      const killer = spawn("taskkill", args, { windowsHide: true, stdio: "ignore" });
      killer.on("error", (err) => {
        this.options.onLog(`taskkill failed (${err.message}); killing the shell instead.`);
        proc.kill();
      });
    } catch (err) {
      this.options.onLog(`taskkill could not be started: ${String(err)}`);
      proc.kill();
    }
  }

  /**
   * Send a request and wait for Kiro's reply.
   *
   * Pass timeoutMs for calls that can silently never answer. Kiro ignores
   * session/set_model outright if the session id does not match, replying
   * with nothing at all, which would otherwise hang us forever.
   */
  request<T = any>(method: string, params?: any, timeoutMs?: number): Promise<T> {
    if (!this.isRunning || !this.proc?.stdin) {
      return Promise.reject(new Error("The Kiro agent is not running."));
    }
    const id = this.nextId++;
    const message = { jsonrpc: "2.0", id, method, params: params ?? {} };
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Kiro did not answer "${method}" in time.`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write(message);
    });
  }

  /** Send a message that expects no reply. */
  notify(method: string, params?: any): void {
    if (!this.isRunning) {
      return;
    }
    this.write({ jsonrpc: "2.0", method, params: params ?? {} });
  }

  private write(message: unknown): void {
    try {
      this.proc?.stdin?.write(JSON.stringify(message) + "\n");
    } catch (err) {
      this.options.onLog(`Failed to write to Kiro: ${String(err)}`);
    }
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      newline = this.stdoutBuffer.indexOf("\n");
      if (line.length === 0) {
        continue;
      }
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        // Not JSON. Kiro sometimes prints plain text before the handshake.
        this.options.onLog(`[kiro stdout] ${line}`);
        continue;
      }
      /*
       * One bad message must not cost us the rest of the chunk.
       *
       * Kiro often writes several notifications in a single stdio write, and
       * this loop walks them in order. A throw anywhere in a handler used to
       * abandon the whole loop, so every line after it in that write was
       * dropped on the floor — silently, and looking exactly like Kiro never
       * having sent them.
       */
      try {
        this.dispatch(message);
      } catch (err) {
        this.options.onLog(
          `Failed to handle ${message?.method ?? "a reply"}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }

    // Whatever is left has no newline in it, so it can never be dispatched on
    // its own. Past the cap it is not a message being assembled any more.
    if (this.stdoutBuffer.length > MAX_PENDING_STDOUT) {
      this.options.onLog(
        `Discarded ${this.stdoutBuffer.length} bytes of unterminated output from Kiro.`
      );
      this.stdoutBuffer = "";
    }
  }

  private dispatch(message: any): void {
    if (typeof message?.method === "string") {
      if (message.id === undefined || message.id === null) {
        this.options.onNotification(message.method, message.params ?? {});
      } else {
        this.handleIncomingRequest(message);
      }
      return;
    }

    // Otherwise it is a reply to something we sent.
    const entry = this.pending.get(message?.id);
    if (!entry) {
      return;
    }
    this.pending.delete(message.id);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    if (message.error) {
      const text = message.error?.message ?? JSON.stringify(message.error);
      entry.reject(new Error(text));
    } else {
      entry.resolve(message.result);
    }
  }

  private handleIncomingRequest(message: any): void {
    const { id, method, params } = message;
    this.options
      .onRequest(method, params ?? {})
      .then((result) => {
        this.write({ jsonrpc: "2.0", id, result: result ?? null });
      })
      .catch((err: Error) => {
        this.write({
          jsonrpc: "2.0",
          id,
          error: { code: -32000, message: err?.message ?? "Request failed" },
        });
      });
  }

  private failAllPending(error: Error): void {
    for (const entry of this.pending.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.reject(error);
    }
    this.pending.clear();
  }
}
