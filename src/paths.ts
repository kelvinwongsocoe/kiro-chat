/**
 * Comparing paths on Windows.
 *
 * The same file can be written several ways — drive-letter case, forward or
 * back slashes, a trailing separator — and comparing the raw strings gets it
 * wrong in both directions: it hides a user's own chats from the history list,
 * and it attaches the same file to a message twice.
 *
 * Free of any `vscode` import so it can be exercised on its own.
 */

export function normalisePath(value: string | undefined): string {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** Whole-path equality, so "b-old" never counts as "b". */
export function samePath(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return normalisePath(a) === normalisePath(b);
}
