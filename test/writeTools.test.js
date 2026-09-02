// Telling a file-editing tool from any other tool.
//
// This decides two things: whether a direct Kiro write gets snapshotted for
// review, and whether the permission prompt is skipped because the diff is
// about to ask the same question. Getting it wrong in one direction gives you
// two approval gates for one edit; in the other, it silently waves through a
// tool that should have been asked about.
const test = require("node:test");
const assert = require("node:assert/strict");

const { isWriteLikeTool } = require("../out/writeTools");

test("the tool kinds Kiro uses for edits are recognised", () => {
  assert.equal(isWriteLikeTool({ kind: "edit" }), true);
  assert.equal(isWriteLikeTool({ kind: "write" }), true);
  // ACP sends camelCase kinds too.
  assert.equal(isWriteLikeTool({ toolCall: { kind: "edit" } }), true);
});

test("the titles Kiro narrates edits with are recognised", () => {
  assert.equal(isWriteLikeTool({ title: "Editing src/usage.ts" }), true);
  assert.equal(isWriteLikeTool({ title: "Writing CLAUDE.md" }), true);
  assert.equal(isWriteLikeTool({ toolCall: { title: "editing a file" } }), true);
});

test("the rawInput commands Kiro uses for edits are recognised", () => {
  for (const command of ["strReplace", "replace", "write", "create", "overwrite"]) {
    assert.equal(
      isWriteLikeTool({ rawInput: { command } }),
      true,
      `${command} should count as a write`
    );
  }
  assert.equal(isWriteLikeTool({ input: { mode: "create" } }), true);
});

/**
 * Anything that is not an edit still has to be asked about. Waving these
 * through would skip the only gate they have.
 */
test("tools that are not edits are not treated as writes", () => {
  assert.equal(isWriteLikeTool({ kind: "read" }), false);
  assert.equal(isWriteLikeTool({ kind: "execute" }), false);
  assert.equal(isWriteLikeTool({ kind: "fetch" }), false);
  assert.equal(isWriteLikeTool({ title: "Reading src/usage.ts" }), false);
  assert.equal(isWriteLikeTool({ title: "Searching for readMeter" }), false);
  assert.equal(isWriteLikeTool({ rawInput: { command: "grep" } }), false);
});

/** "rewrite the docs" is a sentence, not a write command. */
test("a title that merely mentions writing is not a write", () => {
  assert.equal(isWriteLikeTool({ title: "Thinking about rewriting the parser" }), false);
  assert.equal(isWriteLikeTool({ title: "Considering an edit to CLAUDE.md" }), false);
});

test("nothing at all is not a write", () => {
  assert.equal(isWriteLikeTool(undefined), false);
  assert.equal(isWriteLikeTool({}), false);
  assert.equal(isWriteLikeTool(null), false);
});

// ---- the flow this detector exists to fix -----------------------------

const fs = require("node:fs");
const path = require("node:path");
const session = fs.readFileSync(
  path.join(__dirname, "..", "src", "kiroSession.ts"),
  "utf8"
);

/**
 * An edit used to be approved twice: a permission card asking "may I write
 * this file?", and then a review diff asking "keep these changes?". The first
 * is asked before there is anything to look at, which is the wrong moment and
 * the wrong question.
 */
test("an edit is not also prompted for when the review will open", () => {
  const ask = session.slice(session.indexOf("private async askPermission"));
  const body = ask.slice(0, 2200);
  assert.match(body, /isWriteLikeTool/, "askPermission must recognise an edit");
  assert.match(body, /reviewWillOpen/, "and skip its prompt when the diff is coming");
});

/**
 * With review off, writing off, or a read-only workflow, no diff opens — so
 * the permission prompt is the only gate there is and must still be asked.
 */
test("the prompt stays when no review will open", () => {
  const ask = session.slice(session.indexOf("private async askPermission"));
  const body = ask.slice(0, 2200);
  for (const guard of ["reviewFileWrites", "allowFileWrites", "turnReadOnly"]) {
    assert.ok(body.includes(guard), `skipping the prompt must depend on ${guard}`);
  }
});

/** Both callers must agree on what an edit is, or they disagree in the field. */
test("there is one definition of a write-like tool, not two", () => {
  assert.match(
    session,
    /if \(!isWriteLikeTool\(update\)\) return;/,
    "observeDirectFileWrite should use the shared detector"
  );
  assert.doesNotMatch(
    session,
    /const writeLike =/,
    "the old inline copy of the heuristic should be gone"
  );
});
