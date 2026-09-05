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
  // The whole method. A fixed 2200 characters broke the moment a comment was
  // added inside it, which says nothing about whether the code is right.
  const body = ask.slice(0, ask.indexOf("\n  private "));
  assert.match(body, /isWriteLikeTool/, "askPermission must recognise an edit");
  assert.match(body, /reviewWillOpen/, "and skip its prompt when the diff is coming");
});

/**
 * With review off, writing off, or a read-only workflow, no diff opens — so
 * the permission prompt is the only gate there is and must still be asked.
 */
/*
 * The branch that lets an edit through without asking writes down that it
 * did, and says why. Auto-approve returned in silence, so with
 * `kiroChat.autoApproveTools` on there was no record anywhere — not the
 * panel, not the log — that a permission had been granted at all.
 */
test("an auto-approved permission is written to the log", () => {
  const ask = session.slice(session.indexOf("private async askPermission"));
  const body = ask.slice(0, ask.indexOf("\n  private "));
  const auto = body.slice(body.indexOf("if (autoApprove) {"));
  const branch = auto.slice(0, auto.indexOf("\n    }"));
  assert.match(branch, /this\.output\.appendLine\(/, "say that it was granted");
  assert.match(branch, /autoApproveTools/, "and why it was never asked");
});

test("the prompt stays when no review will open", () => {
  const ask = session.slice(session.indexOf("private async askPermission"));
  // The whole method. A fixed 2200 characters broke the moment a comment was
  // added inside it, which says nothing about whether the code is right.
  const body = ask.slice(0, ask.indexOf("\n  private "));
  for (const guard of ["reviewFileWrites", "allowFileWrites", "turnReadOnly"]) {
    assert.ok(body.includes(guard), `skipping the prompt must depend on ${guard}`);
  }
});

/** Both callers must agree on what an edit is, or they disagree in the field. */
test("there is one definition of a write-like tool, not two", () => {
  assert.match(
    session,
    /if \(!isWriteLikeTool\(update\)\) return;/,
    "observeToolPaths should use the shared detector"
  );
  assert.doesNotMatch(
    session,
    /const writeLike =/,
    "the old inline copy of the heuristic should be gone"
  );
});

// ---- the other half: what positively cannot have written -----------
//
// Snapshots are taken for every file a tool mentions, but only a file that
// might have been *written* earns a review diff. The default answer here is
// false on purpose: an unknown tool is assumed to have written, which is what
// keeps an unrecognised edit reviewable.

const { isReadOnlyTool } = require("../out/writeTools");

test("the kinds that cannot change a file are recognised", () => {
  for (const kind of ["read", "search", "grep", "glob", "list", "fetch", "think"]) {
    assert.equal(isReadOnlyTool({ kind }), true, `${kind} cannot write`);
  }
});

test("an unknown tool is assumed to have written", () => {
  assert.equal(isReadOnlyTool({ kind: "something_new" }), false);
  assert.equal(isReadOnlyTool({ kind: "" }), false);
  assert.equal(isReadOnlyTool({}), false);
  assert.equal(isReadOnlyTool(undefined), false);
});

/** A command can write anything, and terminal access being off is not a proof. */
test("running a command is never treated as read-only", () => {
  for (const kind of ["execute", "shell", "bash"]) {
    assert.equal(isReadOnlyTool({ kind }), false, `${kind} could write`);
  }
});

/** The two answers must never both be true for one update. */
test("a write-like tool is never also read-only", () => {
  const writes = [
    { kind: "edit" },
    { kind: "write" },
    { title: "Editing src/app.ts" },
    { rawInput: { command: "strReplace" } },
    // A kind on the read-only list, but the input says it replaces text.
    { kind: "read", rawInput: { command: "strReplace" } },
  ];
  for (const update of writes) {
    assert.equal(isWriteLikeTool(update), true, JSON.stringify(update));
    assert.equal(isReadOnlyTool(update), false, JSON.stringify(update));
  }
});
