/**
 * Drives the first-run setup screen so the user does not have to.
 *
 * Once the panel knows kiro-cli is missing, this watches for it appearing on
 * disk and then tries the handshake itself. The user installs Kiro in the
 * terminal and the panel turns into a chat on its own.
 *
 * Kept free of any `vscode` import, and with its timers injected, so the state
 * machine can be exercised on its own — see `test/setupWatcher.test.js`. The
 * failures that matter here are all invisible in the UI: a poll that never
 * stops, a state reported into a webview that has already closed, a retry loop
 * that spins for the rest of the session.
 */

export type SetupState =
  /** Polling for the binary. */
  | "looking"
  /** The binary is on disk. Detail carries where. */
  | "found"
  /** Trying the ACP handshake. */
  | "connecting"
  /** Kiro is there but would not start. Detail carries why. */
  | "needs-signin"
  /** Done. The panel can become a chat. */
  | "connected"
  /** Polled past the cap. The user gets a button instead. */
  | "gave-up"
  /**
   * A reconnect used up its retries. Detail carries the real error — the
   * whole point of this state is not to blame the user's login for it.
   */
  | "failed";

/** setTimeout, injectable so tests do not have to wait out a real interval. */
export interface Scheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface SetupWatcherOptions {
  /** Where kiro-cli is, or undefined if it is still not there. */
  probe: () => Promise<string | undefined>;
  /** Attempt the ACP handshake. Rejects when Kiro will not start. */
  connect: () => Promise<void>;
  onState: (state: SetupState, detail?: string) => void;
  /** How often to look for the binary while the installer runs. */
  lookIntervalMs?: number;
  /** How often to retry the handshake once the user says they signed in. */
  signInIntervalMs?: number;
  /** How long to wait between the quiet retries of a reconnect. */
  reconnectIntervalMs?: number;
  maxLookAttempts?: number;
  maxSignInAttempts?: number;
  maxReconnectAttempts?: number;
  scheduler?: Scheduler;
}

type Phase = "idle" | "looking" | "signing-in" | "reconnecting";

export class SetupWatcher {
  private readonly scheduler: Scheduler;
  private readonly lookIntervalMs: number;
  private readonly signInIntervalMs: number;
  private readonly reconnectIntervalMs: number;
  private readonly maxLookAttempts: number;
  private readonly maxSignInAttempts: number;
  private readonly maxReconnectAttempts: number;

  private phase: Phase = "idle";
  private handle: unknown;
  private attempts = 0;
  /** What the last failed connect said, so "failed" can carry it. */
  private lastError: string | undefined;

  /**
   * The poll currently in flight. Tests await this rather than guessing how
   * many microtask turns a cycle takes.
   */
  private cycle: Promise<void> = Promise.resolve();

  constructor(private readonly options: SetupWatcherOptions) {
    this.scheduler = options.scheduler ?? realScheduler;
    this.lookIntervalMs = options.lookIntervalMs ?? 2000;
    this.signInIntervalMs = options.signInIntervalMs ?? 5000;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 2000;
    // Ten minutes of looking, then two minutes of sign-in retries.
    this.maxLookAttempts = options.maxLookAttempts ?? 300;
    this.maxSignInAttempts = options.maxSignInAttempts ?? 24;
    // Three tries over about six seconds: long enough to ride out a slow
    // spawn, short enough that a real problem is not hidden behind a spinner.
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 3;
  }

  /** Resolves once the in-flight poll has finished. For tests. */
  settled(): Promise<void> {
    return this.cycle;
  }

  /** Begin watching for the binary. Safe to call more than once. */
  start(): void {
    if (this.phase !== "idle") return;
    this.phase = "looking";
    this.attempts = 0;
    this.emit("looking");
    // We only get here because a probe just failed, so wait before re-checking.
    this.queue(this.lookIntervalMs);
  }

  /** The user has gone to sign in. Retry the handshake until it takes. */
  signIn(): void {
    if (this.phase === "signing-in") return;
    this.cancelTimer();
    this.phase = "signing-in";
    this.attempts = 0;
    this.queue(this.signInIntervalMs);
  }

  /**
   * The agent was restarted and the first attempt failed. Retry quietly a few
   * times before saying anything: a torn-down client, a slow spawn or a
   * dropped pipe all fix themselves, and the user was chatting seconds ago so
   * they are certainly still signed in.
   *
   * This owns every attempt, including the first, which runs straight away —
   * so the caller hands the whole reconnect over rather than trying once
   * itself and leaving the count split between two places.
   */
  reconnect(): void {
    this.cancelTimer();
    this.phase = "reconnecting";
    this.attempts = 0;
    this.lastError = undefined;
    this.cycle = this.tick();
  }

  /** Stop for good. Nothing is reported after this. */
  stop(): void {
    this.cancelTimer();
    this.phase = "idle";
  }

  private cancelTimer(): void {
    if (this.handle !== undefined) {
      this.scheduler.clear(this.handle);
      this.handle = undefined;
    }
  }

  private queue(delayMs: number): void {
    this.cancelTimer();
    this.handle = this.scheduler.set(() => {
      this.handle = undefined;
      this.cycle = this.tick();
    }, delayMs);
  }

  private emit(state: SetupState, detail?: string): void {
    this.options.onState(state, detail);
  }

  private async tick(): Promise<void> {
    const phase = this.phase;
    if (phase === "idle") return;

    this.attempts++;
    if (this.attempts > this.capFor(phase)) {
      this.stop();
      // A reconnect has a real error to report; the others just ran out of
      // patience waiting for the user.
      if (phase === "reconnecting") this.emit("failed", this.lastError);
      else this.emit("gave-up");
      return;
    }

    if (phase === "looking") {
      let found: string | undefined;
      try {
        found = await this.options.probe();
      } catch {
        // A probe that throws is the same as one that found nothing.
      }
      // The panel may have closed while that was in flight.
      if (this.phase !== "looking") return;
      if (!found) {
        this.queue(this.lookIntervalMs);
        return;
      }
      this.emit("found", found);
    }

    await this.attemptConnect(phase);
  }

  private capFor(phase: Phase): number {
    if (phase === "looking") return this.maxLookAttempts;
    if (phase === "reconnecting") return this.maxReconnectAttempts;
    return this.maxSignInAttempts;
  }

  private async attemptConnect(phase: Phase): Promise<void> {
    this.emit("connecting");
    try {
      await this.options.connect();
    } catch (err) {
      if (this.phase !== phase) return;
      const message = err instanceof Error ? err.message : String(err);
      this.lastError = message;
      if (phase === "signing-in") {
        // Still not signed in. Keep retrying until the cap.
        this.queue(this.signInIntervalMs);
        return;
      }
      if (phase === "reconnecting") {
        // Quietly, behind the loading state, until the retries run out.
        this.queue(this.reconnectIntervalMs);
        return;
      }
      // Kiro is installed but will not start. Wait for the user to sign in.
      this.stop();
      this.emit("needs-signin", message);
      return;
    }

    if (this.phase !== phase) return;
    this.stop();
    this.emit("connected");
  }
}
