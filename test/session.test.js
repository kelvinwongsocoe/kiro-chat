// Guards on KiroSession that cannot be unit tested, because the module imports
// vscode. Static, like the webview guards, and for the same reason: these are
// failures that only show up as "the UI lost something".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const session = fs.readFileSync(
  path.join(__dirname, "..", "src", "kiroSession.ts"),
  "utf8"
);

/**
 * Neither session/new nor session/load carries a credit rate — verified
 * against kiro-cli 2.20.2, where the model list is id/name/description only.
 * The rates come from the separate `model` command, so any code path that
 * rebuilds the model list has to ask for them again or the rate badges
 * silently vanish for the rest of the session.
 */
test("every path that rebuilds the model list also fetches the credit rates", () => {
  const rebuilds = [...session.matchAll(/this\.readModels\(/g)];
  assert.ok(rebuilds.length >= 2, "expected session/new and session/load to both read models");

  for (const match of rebuilds) {
    // The enrichModels call should follow within the same method.
    const after = session.slice(match.index, match.index + 700);
    assert.match(
      after,
      /enrichModels\(\)/,
      `readModels at index ${match.index} rebuilds the list without refetching credit rates`
    );
  }
});
