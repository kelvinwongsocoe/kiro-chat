// Kiro failing to start used to be reported as "you are not signed in",
// whatever actually went wrong. On a restart that is nearly always a lie —
// the user was chatting a moment ago — and it sends them off to log in again
// instead of showing them the real problem.
const test = require("node:test");
const assert = require("node:assert/strict");

const { looksLikeSignIn } = require("../out/startupError");

test("the messages Kiro actually uses for a missing login are recognised", () => {
  for (const message of [
    "Unauthorized",
    "401 Unauthorized",
    "You are not logged in. Run kiro-cli login.",
    "not authenticated",
    "Authentication required",
    "Your credentials have expired",
    "invalid_token",
    "Please sign in to continue",
    "Login required",
  ]) {
    assert.equal(looksLikeSignIn(message), true, `should be a sign-in problem: ${message}`);
  }
});

test("everything else is reported as what it is", () => {
  for (const message of [
    "Kiro did not return a session id.",
    "The Kiro agent stopped running.",
    'Could not start "kiro-cli.exe": spawn EINVAL',
    "Kiro did not answer \"initialize\" in time.",
    "ENOENT: no such file or directory",
    "Path is outside the open folder: ../secrets",
    "",
  ]) {
    assert.equal(looksLikeSignIn(message), false, `should not be a sign-in problem: ${message}`);
  }
});

/**
 * "auth" appears inside plenty of unrelated words. Matching it loosely would
 * put us straight back to sending people to a login screen for no reason.
 */
test("a bare substring is not enough to blame the login", () => {
  assert.equal(looksLikeSignIn("author.ts could not be read"), false);
  assert.equal(looksLikeSignIn("Unauthorised change to authors file"), true);
});

test("the check does not care about case or surrounding noise", () => {
  assert.equal(looksLikeSignIn("  ERROR: UNAUTHORIZED (code 401)  "), true);
  assert.equal(looksLikeSignIn("request failed: Not Logged In"), true);
});
