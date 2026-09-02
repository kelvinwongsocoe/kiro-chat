import * as path from "node:path";
import * as vscode from "vscode";
import { applySelectedLines, buildReviewDiff, ReviewDiff } from "./lineDiff";

export interface ChangeReviewRequest {
  path: string;
  /**
   * The real file on disk, used only to read its language off. The review
   * document's own name cannot end in the extension, so VS Code cannot work
   * the language out for itself.
   */
  sourcePath?: string;
  before: string;
  after: string;
  /** A missing file with empty content is still a proposed creation. */
  creating: boolean;
  /** Apply each accepted hunk immediately while the review remains open. */
  applyContent?: (content: string, exists: boolean) => Promise<void>;
}

export type ChangeReviewDecision =
  | { accepted: false }
  | { accepted: true; content: string; selected: number; total: number };

/** What the chat needs to know about the review currently on screen. */
export interface ActiveReviewInfo {
  path: string;
  hunks: number;
  decided: number;
}

interface RenderedHunk {
  id: number;
  headerLine: number;
  startLine: number;
  endLine: number;
}

interface RenderedReview {
  content: string;
  inserted: vscode.Range[];
  deleted: vscode.Range[];
  hunks: Map<number, RenderedHunk>;
}

interface ActiveReview {
  id: string;
  request: ChangeReviewRequest;
  diff: ReviewDiff;
  uri: vscode.Uri;
  decisions: Map<number, boolean>;
  rendered: RenderedReview;
  appliedContent: string;
  appliedExists: boolean;
  applying: boolean;
  cancelRequested: boolean;
  resolve: (decision: ChangeReviewDecision) => void;
  settled: boolean;
}

const REVIEW_SCHEME = "kiro-change-review";
const ACCEPT_ALL = "kiroChat.review.acceptAll";
const REJECT_ALL = "kiroChat.review.rejectAll";
const ACCEPT_HUNK = "kiroChat.review.acceptHunk";
const REJECT_HUNK = "kiroChat.review.rejectHunk";
const ACCEPT_AT_CURSOR = "kiroChat.review.acceptAtCursor";
const REJECT_AT_CURSOR = "kiroChat.review.rejectAtCursor";
const NEXT_CHANGE = "kiroChat.review.nextChange";
const PREVIOUS_CHANGE = "kiroChat.review.previousChange";

function freshId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * A normal, read-only editor document containing both sides of pending hunks.
 * Pending deletions and insertions coexist; resolved hunks collapse to only
 * the accepted side, which makes the decoration disappear immediately.
 */
export function renderReview(
  before: string,
  after: string,
  diff: ReviewDiff,
  decisions: ReadonlyMap<number, boolean>
): RenderedReview {
  const hunkForChange = new Map<number, number>();
  for (const hunk of diff.hunks) {
    for (const row of hunk.rows) {
      if (row.changeId !== undefined) hunkForChange.set(row.changeId, hunk.id);
    }
  }

  const chunks: string[] = [];
  const inserted: vscode.Range[] = [];
  const deleted: vscode.Range[] = [];
  const hunks = new Map<number, RenderedHunk>();
  let outputLine = 0;

  const append = (raw: string): number => {
    const line = outputLine;
    chunks.push(raw);
    if (/\r\n$|\r$|\n$/.test(raw)) outputLine++;
    return line;
  };
  const markPending = (hunkId: number, line: number): void => {
    const current = hunks.get(hunkId);
    if (current) current.endLine = line;
    else hunks.set(hunkId, { id: hunkId, headerLine: line, startLine: line, endLine: line });
  };

  for (const row of diff.rows) {
    if (row.kind === "equal") {
      append(row.raw);
      continue;
    }

    const hunkId = hunkForChange.get(row.changeId!);
    if (hunkId === undefined) continue;
    const decision = decisions.get(hunkId);

    if (row.kind === "delete" && decision !== true) {
      const line = append(row.raw);
      if (decision === undefined) {
        deleted.push(new vscode.Range(line, 0, line, 0));
        markPending(hunkId, line);
      }
    }
    if (row.kind === "insert" && decision !== false) {
      const line = append(row.raw);
      if (decision === undefined) {
        inserted.push(new vscode.Range(line, 0, line, 0));
        markPending(hunkId, line);
      }
    }
  }

  // Keep these arguments in the signature as an explicit reminder that the
  // rendering is an exact combination of the two versions represented by diff.
  void before;
  void after;
  return { content: chunks.join(""), inserted, deleted, hunks };
}

/** Native editor review with inline diff decorations and per-hunk CodeLens actions. */
export class ChangeReviewer implements vscode.CodeLensProvider, vscode.Disposable {
  private queue: Promise<void> = Promise.resolve();
  /** Hunk decisions run one at a time so a quick second click is not lost. */
  private decisions: Promise<void> = Promise.resolve();
  private active: ActiveReview | undefined;
  private disposed = false;
  private generation = 0;
  private registered = false;
  private readonly documents = new Map<string, string>();
  private readonly registrations: vscode.Disposable[] = [];
  private documentEmitter: vscode.EventEmitter<vscode.Uri> | undefined;
  private codeLensEmitter: vscode.EventEmitter<void> | undefined;
  private insertedDecoration: vscode.TextEditorDecorationType | undefined;
  private deletedDecoration: vscode.TextEditorDecorationType | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  get onDidChangeCodeLenses(): vscode.Event<void> | undefined {
    return this.codeLensEmitter?.event;
  }

  /**
   * Fires when a review opens or settles, so the chat can offer to keep or
   * undo the whole lot while the diff is still on screen — the point at which
   * the user can actually see what is being proposed.
   */
  readonly onDidChangeActiveReview = new vscode.EventEmitter<ActiveReviewInfo | undefined>();

  private announceActive(): void {
    const review = this.active;
    this.onDidChangeActiveReview.fire(
      review && !review.settled
        ? {
            path: review.request.path,
            hunks: review.diff.hunks.length,
            decided: review.decisions.size,
          }
        : undefined
    );
  }

  /** Accept every pending hunk of the review on screen. */
  async acceptActive(): Promise<void> {
    const review = this.active;
    if (review && !review.settled) await this.acceptAll(review.id);
  }

  /** Reject the review on screen, restoring the original. */
  async rejectActive(): Promise<void> {
    const review = this.active;
    if (review && !review.settled) await this.rejectAll(review);
  }

  review(request: ChangeReviewRequest): Promise<ChangeReviewDecision> {
    const generation = this.generation;
    const task = this.queue.then(() =>
      generation === this.generation ? this.open(request) : { accepted: false as const }
    );
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const review = this.active;
    if (!review || document.uri.toString() !== review.uri.toString()) return [];

    const at = (line: number) => {
      const safe = Math.max(0, Math.min(line, Math.max(0, document.lineCount - 1)));
      return new vscode.Range(safe, 0, safe, 0);
    };
    /*
     * CodeLenses, not inlay hints.
     *
     * An inlay hint label part with a `command` looks more like a button —
     * VS Code paints it as a chip — but it is only interactive through
     * ClickLinkGesture, which fires solely when the trigger modifier is held.
     * A plain click does nothing, which makes it useless as the primary
     * control. A CodeLens cannot be styled at all, but it clicks.
     */
    const lenses = [
      new vscode.CodeLens(at(0), {
        title: "Accept all",
        tooltip: "Accept every proposed change in this file",
        command: ACCEPT_ALL,
        arguments: [review.id],
      }),
      new vscode.CodeLens(at(0), {
        title: "Reject all",
        tooltip: "Reject every proposed change in this file",
        command: REJECT_ALL,
        arguments: [review.id],
      }),
    ];

    // Only worth offering when there is somewhere else to go.
    if (review.rendered.hunks.size > 1) {
      lenses.push(
        new vscode.CodeLens(at(0), {
          title: "Next change",
          tooltip: "Jump to the next change awaiting a decision",
          command: NEXT_CHANGE,
          arguments: [],
        }),
        new vscode.CodeLens(at(0), {
          title: "Previous change",
          tooltip: "Jump to the previous change awaiting a decision",
          command: PREVIOUS_CHANGE,
          arguments: [],
        })
      );
    }

    for (const hunk of review.rendered.hunks.values()) {
      lenses.push(
        new vscode.CodeLens(at(hunk.headerLine), {
          title: "Accept",
          tooltip: "Apply this change",
          command: ACCEPT_HUNK,
          arguments: [review.id, hunk.id],
        }),
        new vscode.CodeLens(at(hunk.headerLine), {
          title: "Reject",
          tooltip: "Discard this change",
          command: REJECT_HUNK,
          arguments: [review.id, hunk.id],
        })
      );
    }
    return lenses;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPending();
    this.onDidChangeActiveReview.dispose();
    for (const registration of this.registrations) registration.dispose();
    this.registrations.length = 0;
    this.documents.clear();
  }

  /** Reject the visible review and anything queued behind it. */
  cancelPending(): void {
    this.generation++;
    if (this.active) {
      this.active.cancelRequested = true;
      void this.rejectAll(this.active);
    }
  }

  private ensureRegistered(): void {
    if (this.registered) return;
    this.registered = true;
    this.documentEmitter = new vscode.EventEmitter<vscode.Uri>();
    this.codeLensEmitter = new vscode.EventEmitter<void>();
    this.insertedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("diffEditorOverview.insertedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    this.deletedDecoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
      overviewRulerColor: new vscode.ThemeColor("diffEditorOverview.removedForeground"),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    });
    const provider: vscode.TextDocumentContentProvider = {
      onDidChange: this.documentEmitter.event,
      provideTextDocumentContent: (uri) => this.documents.get(uri.toString()) ?? "",
    };

    this.registrations.push(
      this.documentEmitter,
      this.codeLensEmitter,
      this.insertedDecoration,
      this.deletedDecoration,
      vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, provider),
      vscode.languages.registerCodeLensProvider({ scheme: REVIEW_SCHEME }, this),
      vscode.commands.registerCommand(ACCEPT_ALL, (reviewId: string) =>
        this.acceptAll(reviewId)
      ),
      vscode.commands.registerCommand(REJECT_ALL, (reviewId: string) => {
        const review = this.match(reviewId);
        if (review) return this.rejectAll(review);
      }),
      vscode.commands.registerCommand(ACCEPT_HUNK, (reviewId: string, hunkId: number) =>
        this.decideHunk(reviewId, hunkId, true)
      ),
      vscode.commands.registerCommand(REJECT_HUNK, (reviewId: string, hunkId: number) =>
        this.decideHunk(reviewId, hunkId, false)
      ),
      vscode.commands.registerCommand(ACCEPT_AT_CURSOR, () => this.decideAtCursor(true)),
      vscode.commands.registerCommand(REJECT_AT_CURSOR, () => this.decideAtCursor(false)),
      vscode.commands.registerCommand(NEXT_CHANGE, () => this.gotoNext()),
      vscode.commands.registerCommand(PREVIOUS_CHANGE, () => this.gotoPrevious()),
      vscode.window.onDidChangeVisibleTextEditors((editors) => this.paintVisible(editors)),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.scheme === REVIEW_SCHEME) this.schedulePaint();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const review = this.active;
        if (review && document.uri.toString() === review.uri.toString() && !review.settled) {
          // Closing keeps what was already accepted; only undecided hunks go.
          void this.rejectAll(review, false, true);
        }
      })
    );
  }

  /** Give the review document the language of the file it is reviewing. */
  private async applyLanguage(
    document: vscode.TextDocument,
    request: ChangeReviewRequest
  ): Promise<vscode.TextDocument> {
    if (!request.sourcePath) return document;
    try {
      const source = await vscode.workspace.openTextDocument(
        vscode.Uri.file(request.sourcePath)
      );
      if (!source.languageId || source.languageId === document.languageId) return document;
      return await vscode.languages.setTextDocumentLanguage(document, source.languageId);
    } catch (err) {
      // Plain text is a worse review, not a broken one.
      this.output.appendLine(
        `Could not read the language of ${request.path}: ${this.message(err)}`
      );
      return document;
    }
  }

  private async open(request: ChangeReviewRequest): Promise<ChangeReviewDecision> {
    if (this.disposed) return { accepted: false };
    const generation = this.generation;
    this.ensureRegistered();

    const id = freshId();
    const filename = path.basename(request.path).replace(/[^a-zA-Z0-9._-]/g, "_") || "change.txt";
    /*
     * The tab must not look like the file itself.
     *
     * This document is a third thing — both sides of the pending change merged
     * together — and a tab labelled exactly like the real file invites editing
     * the wrong one. VS Code takes the tab title from the URI's basename, so
     * the marker has to live there. Git names its diff of the same file
     * `chat.js (Working Tree)`, which is the convention the editor already
     * teaches; `applyLanguage` puts back the syntax highlighting that naming
     * it this way costs.
     */
    const label = `${filename} (Working Tree)`;
    const uri = vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${id}/${label}` });
    // Review hunks are deliberately finer than display-only diff hunks. With
    // zero context, every contiguous changed block gets its own decision even
    // when another edit is only one unchanged source line away.
    const diff = buildReviewDiff(request.before, request.after, 0);
    const decisions = new Map<number, boolean>();
    const rendered = renderReview(request.before, request.after, diff, decisions);

    let resolve!: (decision: ChangeReviewDecision) => void;
    const result = new Promise<ChangeReviewDecision>((done) => {
      resolve = done;
    });
    const review: ActiveReview = {
      id,
      request,
      diff,
      uri,
      decisions,
      rendered,
      appliedContent: request.before,
      appliedExists: !request.creating,
      applying: false,
      cancelRequested: false,
      resolve,
      settled: false,
    };
    this.documents.set(uri.toString(), rendered.content);
    this.output.appendLine(
      `Reviewing ${request.path} inline: ${diff.hunks.length} hunk(s), +${diff.additions} -${diff.deletions}.`
    );

    try {
      let document = await vscode.workspace.openTextDocument(uri);
      /*
       * The language has to be set explicitly, and set before the review is
       * the active one.
       *
       * A name ending in "(Working Tree)" tells VS Code nothing about the
       * language, so the diff would render as plain text — colour is half of
       * what makes it readable. `setTextDocumentLanguage` recreates the
       * document, which fires onDidCloseTextDocument for the old one; that is
       * the same event the user closing the tab produces, so doing this after
       * `this.active = review` would make the review reject itself the instant
       * it opened.
       */
      document = await this.applyLanguage(document, request);

      this.active = review;
      // A cancel that arrived while the document was opening had nothing to
      // cancel, because there was no active review yet.
      if (generation !== this.generation) {
        this.finish(review, { accepted: false });
        return result;
      }
      const editor = await vscode.window.showTextDocument(document, { preview: false });
      if (this.active === review) {
        this.paint(editor, review);
        this.codeLensEmitter?.fire();
        await vscode.commands.executeCommand("setContext", "kiroChat.hunkReviewActive", true);
        this.announceActive();
      }
    } catch (err) {
      this.output.appendLine(
        `Could not open the inline review for ${request.path}: ${this.message(err)}`
      );
      this.finish(review, { accepted: false });
    }
    return result;
  }

  private match(reviewId: string): ActiveReview | undefined {
    return this.active?.id === reviewId ? this.active : undefined;
  }

  private async acceptAll(reviewId: string): Promise<void> {
    const review = this.match(reviewId);
    if (!review || review.applying) return;
    const decision = this.allDecision(review);
    review.applying = true;
    try {
      await this.applyDecision(review, decision);
      if (review.cancelRequested) return;
      this.finish(review, decision);
    } catch (err) {
      this.reportApplyError(review, err);
    } finally {
      review.applying = false;
      if (review.cancelRequested && !review.settled) void this.rejectAll(review);
    }
  }

  /**
   * Abandon the review, keeping whatever was already accepted.
   *
   * `keepDecided` is what closing the tab wants: a hunk the user accepted was
   * written to disk the moment they clicked, and they watched it happen.
   * Rewriting the pre-turn contents over the whole file would silently undo
   * work they had already agreed to. Only the hunks nobody decided are
   * dropped.
   *
   * Cancelling the turn is the other case, and there it really does mean all
   * of it: the run is being abandoned, so nothing it produced should stay.
   */
  private async rejectAll(
    review: ActiveReview,
    closeEditor = true,
    keepDecided = false
  ): Promise<void> {
    if (review.settled) return;
    if (review.applying) {
      review.cancelRequested = true;
      return;
    }
    review.applying = true;
    const decision = keepDecided ? this.decidedHunks(review) : { accepted: false as const };
    try {
      await this.applyDecision(review, decision);
      this.finish(review, decision, closeEditor);
    } catch (err) {
      this.reportApplyError(review, err);
      this.finish(review, decision, closeEditor);
    } finally {
      review.applying = false;
    }
  }

  /**
   * Decisions are queued, not dropped.
   *
   * Accepting a hunk writes to disk, which takes a moment. A second click
   * arriving during that used to be discarded by the `applying` guard with
   * nothing on screen to say so — the count stopped falling, the button
   * appeared dead, and because the last decision never landed the review could
   * never complete. Clicking two hunks in a row is the normal way to use this,
   * so it has to wait its turn rather than be thrown away.
   */
  private decideHunk(reviewId: string, hunkId: number, accepted: boolean): Promise<void> {
    const run = this.decisions.then(() => this.applyHunkDecision(reviewId, hunkId, accepted));
    this.decisions = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async applyHunkDecision(
    reviewId: string,
    hunkId: number,
    accepted: boolean
  ): Promise<void> {
    const review = this.match(reviewId);
    if (
      !review ||
      review.settled ||
      review.decisions.has(hunkId) ||
      !review.diff.hunks.some((hunk) => hunk.id === hunkId)
    ) {
      return;
    }

    review.applying = true;
    review.decisions.set(hunkId, accepted);
    const decision = this.decidedHunks(review);
    try {
      await this.applyDecision(review, decision);
      review.rendered = renderReview(
        review.request.before,
        review.request.after,
        review.diff,
        review.decisions
      );
      this.documents.set(review.uri.toString(), review.rendered.content);
      this.documentEmitter?.fire(review.uri);
      this.codeLensEmitter?.fire();
      this.announceActive();
      this.schedulePaint();

      if (review.cancelRequested) return;
      if (review.decisions.size === review.diff.hunks.length) {
        this.finish(review, decision);
      }
    } catch (err) {
      review.decisions.delete(hunkId);
      this.reportApplyError(review, err);
    } finally {
      review.applying = false;
      if (review.cancelRequested && !review.settled) void this.rejectAll(review);
    }
  }

  /** Move to the next change still awaiting a decision. */
  async gotoNext(): Promise<void> {
    await this.gotoChange(true);
  }

  /** Move to the previous change still awaiting a decision. */
  async gotoPrevious(): Promise<void> {
    await this.gotoChange(false);
  }

  /**
   * Walk the pending hunks, wrapping at either end.
   *
   * The cursor is the position, so this stays sane after the user has scrolled
   * or clicked around: from inside a hunk it steps to the neighbouring one,
   * and from anywhere else it goes to the nearest one in that direction. A
   * decided hunk has already collapsed out of `rendered.hunks`, so the walk
   * only ever visits changes that still need an answer.
   */
  private async gotoChange(forward: boolean): Promise<void> {
    const review = this.active;
    if (!review || review.settled) return;
    const hunks = [...review.rendered.hunks.values()].sort(
      (left, right) => left.startLine - right.startLine
    );
    if (hunks.length === 0) return;

    const editor = await this.focusReview(review);
    if (!editor || this.active !== review || review.settled) return;

    const line = editor.selection.active.line;
    const inside = hunks.find((hunk) => line >= hunk.startLine && line <= hunk.endLine);
    let target: RenderedHunk | undefined;
    if (forward) {
      target = inside
        ? hunks.find((hunk) => hunk.startLine > inside.endLine)
        : hunks.find((hunk) => hunk.startLine >= line);
      target = target ?? hunks[0];
    } else {
      const backwards = [...hunks].reverse();
      target = inside
        ? backwards.find((hunk) => hunk.endLine < inside.startLine)
        : backwards.find((hunk) => hunk.endLine <= line);
      target = target ?? hunks[hunks.length - 1];
    }

    editor.selection = new vscode.Selection(target.startLine, 0, target.startLine, 0);
    editor.revealRange(
      new vscode.Range(target.startLine, 0, target.endLine, 0),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport
    );
  }

  /** Bring the review's editor forward, opening it again if it was closed. */
  private async focusReview(review: ActiveReview): Promise<vscode.TextEditor | undefined> {
    const open = vscode.window.visibleTextEditors.find(
      (editor) => editor.document.uri.toString() === review.uri.toString()
    );
    if (open && vscode.window.activeTextEditor === open) return open;
    try {
      const document = await vscode.workspace.openTextDocument(review.uri);
      return await vscode.window.showTextDocument(document, { preview: false });
    } catch (err) {
      this.output.appendLine(
        `Could not focus the review for ${review.request.path}: ${this.message(err)}`
      );
      return undefined;
    }
  }

  private async decideAtCursor(accepted: boolean): Promise<void> {
    const review = this.active;
    const editor = vscode.window.activeTextEditor;
    if (!review || !editor || editor.document.uri.toString() !== review.uri.toString()) return;
    const line = editor.selection.active.line;
    const hunk = [...review.rendered.hunks.values()].find(
      (candidate) => line >= candidate.startLine && line <= candidate.endLine
    );
    if (!hunk) {
      void vscode.window.showInformationMessage(
        "Place the cursor on a red or green changed line, then use the review shortcut."
      );
      return;
    }
    await this.decideHunk(review.id, hunk.id, accepted);
  }

  private allDecision(review: ActiveReview): ChangeReviewDecision {
    const selected = new Set(
      Array.from({ length: review.diff.changeCount }, (_, index) => index)
    );
    return {
      accepted: true,
      content: applySelectedLines(
        review.request.before,
        review.request.after,
        review.diff,
        selected
      ),
      selected: selected.size,
      total: review.diff.changeCount,
    };
  }

  private decidedHunks(review: ActiveReview): ChangeReviewDecision {
    const selected = new Set<number>();
    for (const hunk of review.diff.hunks) {
      if (!review.decisions.get(hunk.id)) continue;
      for (const row of hunk.rows) {
        if (row.changeId !== undefined) selected.add(row.changeId);
      }
    }
    if (selected.size === 0) return { accepted: false };
    return {
      accepted: true,
      content: applySelectedLines(
        review.request.before,
        review.request.after,
        review.diff,
        selected
      ),
      selected: selected.size,
      total: review.diff.changeCount,
    };
  }

  private async applyDecision(
    review: ActiveReview,
    decision: ChangeReviewDecision
  ): Promise<void> {
    const content = decision.accepted ? decision.content : review.request.before;
    const exists = decision.accepted || !review.request.creating;
    if (content === review.appliedContent && exists === review.appliedExists) return;
    await review.request.applyContent?.(content, exists);
    review.appliedContent = content;
    review.appliedExists = exists;
  }

  private paint(editor: vscode.TextEditor, review: ActiveReview): void {
    if (editor.document.uri.toString() !== review.uri.toString()) return;
    if (this.insertedDecoration) {
      editor.setDecorations(this.insertedDecoration, review.rendered.inserted);
    }
    if (this.deletedDecoration) {
      editor.setDecorations(this.deletedDecoration, review.rendered.deleted);
    }
  }

  private paintVisible(editors: readonly vscode.TextEditor[]): void {
    const review = this.active;
    if (!review) return;
    for (const editor of editors) this.paint(editor, review);
  }

  private schedulePaint(): void {
    setTimeout(() => this.paintVisible(vscode.window.visibleTextEditors), 0);
  }

  private reportApplyError(review: ActiveReview, err: unknown): void {
    const message = `Could not apply the reviewed hunk in ${review.request.path}: ${this.message(err)}`;
    this.output.appendLine(message);
    void vscode.window.showErrorMessage(message);
  }

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  private finish(
    review: ActiveReview,
    decision: ChangeReviewDecision,
    closeEditor = true
  ): void {
    if (review.settled) return;
    review.settled = true;
    if (this.active === review) this.active = undefined;
    this.codeLensEmitter?.fire();
    this.announceActive();
    this.paintVisible(vscode.window.visibleTextEditors);
    void vscode.commands.executeCommand("setContext", "kiroChat.hunkReviewActive", false);
    this.output.appendLine(
      decision.accepted
        ? `Accepted ${decision.selected} of ${decision.total} changed lines in ${review.request.path}.`
        : `Rejected proposed changes to ${review.request.path}.`
    );
    review.resolve(decision);

    const activeUri = vscode.window.activeTextEditor?.document.uri;
    if (closeEditor && activeUri?.toString() === review.uri.toString()) {
      void Promise.resolve(
        vscode.commands.executeCommand("workbench.action.closeActiveEditor")
      ).finally(() => this.documents.delete(review.uri.toString()));
    } else {
      this.documents.delete(review.uri.toString());
    }
  }
}
