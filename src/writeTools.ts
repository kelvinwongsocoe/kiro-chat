/**
 * Telling a file-editing tool from any other tool.
 *
 * Two places need the same answer, and they used to disagree because only one
 * of them had a definition:
 *
 * - `observeToolPaths` snapshots the file so the edit can be reviewed.
 * - `askPermission` skips the approval prompt for edits, because the review
 *   diff is about to ask the same question. Asking twice for one edit is the
 *   thing that made the flow feel wrong.
 *
 * Free of any `vscode` import so it can be exercised on its own — see
 * `test/writeTools.test.js`.
 */

function normaliseKind(kind: unknown): string {
  return String(kind ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** The exact commands Kiro's built-in edit tools use. */
const WRITE_COMMANDS = ["strreplace", "str_replace", "replace", "write", "create", "overwrite"];

/**
 * True when this tool call is going to change a file.
 *
 * The title check is anchored to the start on purpose. Kiro narrates an edit
 * as "Editing src/usage.ts", but a sentence like "Thinking about rewriting the
 * parser" merely mentions it — matching that loosely would wave a real prompt
 * through on the strength of a word in a description.
 */
export function isWriteLikeTool(update: unknown): boolean {
  if (!update || typeof update !== "object") return false;
  const value = update as any;

  const kind = normaliseKind(value.kind ?? value.toolCall?.kind);
  if (kind === "edit" || kind === "write") return true;

  const title = String(value.title ?? value.toolCall?.title ?? "").toLowerCase();
  if (title.startsWith("editing ") || title.startsWith("writing ")) return true;

  const raw = value.rawInput ?? value.input ?? value.toolCall?.rawInput;
  const command = normaliseKind(raw?.command ?? raw?.mode);
  return WRITE_COMMANDS.includes(command);
}

/** Kinds that cannot change a file, whatever else they do. */
const READ_ONLY_KINDS = ["read", "search", "grep", "glob", "list", "fetch", "think"];

/**
 * True when this tool call is one that positively cannot have written the file.
 *
 * The default answer is **false**, and that asymmetry is the point. An unknown
 * tool is treated as one that might have written, which is what keeps an
 * unrecognised edit reviewable — the whole of the 0.25.0 fix. Only a kind on
 * this list, and only when it is not also write-like, opts a file out.
 *
 * `execute` / `shell` are deliberately absent: a command can write anything.
 * They should never appear, since the client advertises `terminal: false`, but
 * being wrong about them here would silently skip a review.
 */
export function isReadOnlyTool(update: unknown): boolean {
  if (!update || typeof update !== "object") return false;
  if (isWriteLikeTool(update)) return false;
  const value = update as any;
  const kind = normaliseKind(value.kind ?? value.toolCall?.kind);
  return READ_ONLY_KINDS.includes(kind);
}
