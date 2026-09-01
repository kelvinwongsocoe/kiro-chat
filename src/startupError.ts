/**
 * Working out why Kiro would not start.
 *
 * There used to be one answer to this question — "you are not signed in" —
 * given for every failure between spawning the process and getting a session
 * id back. On a restart that is almost always wrong: the user was chatting
 * seconds ago, so they are signed in, and being sent to log in again hides
 * whatever actually broke.
 *
 * Kept free of any `vscode` import so it can be exercised on its own — see
 * `test/startupError.test.js`.
 */

/**
 * Phrases Kiro and its HTTP layer actually use when the login is the problem.
 * Anchored on word boundaries: "auth" as a loose substring appears in plenty
 * of unrelated messages, and matching it would put us straight back to
 * offering a login screen for no reason.
 */
const SIGN_IN_PATTERNS: RegExp[] = [
  /\bunauthori[sz]ed\b/i,
  /\b401\b/,
  /\bnot\s+logged\s+in\b/i,
  /\bnot\s+authenticated\b/i,
  /\bauthentication\s+(required|failed)\b/i,
  /\bcredentials?\b[^.]*\b(expired|invalid|missing)\b/i,
  /\binvalid[_\s-]?token\b/i,
  /\bexpired[_\s-]?token\b/i,
  /\b(please\s+)?sign\s+in\b/i,
  /\blogin\s+required\b/i,
];

/** True when the failure really does look like a missing or stale login. */
export function looksLikeSignIn(message: string): boolean {
  const text = String(message ?? "");
  if (!text.trim()) return false;
  return SIGN_IN_PATTERNS.some((pattern) => pattern.test(text));
}
