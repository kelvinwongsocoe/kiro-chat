// Files attached in the native chat box — dragged in, #-mentioned, or picked —
// arrive as ChatPromptReference values. They are not one shape: a whole file is
// a Uri, a selected range is a Location, and some references are plain strings
// with nothing on disk behind them.
const test = require("node:test");
const assert = require("node:assert/strict");

const { filesFromReferences } = require("../out/references");

// Stand-ins for vscode.Uri and vscode.Location, which are just shapes here.
const uri = (fsPath) => ({ fsPath, scheme: "file" });
const location = (fsPath, start, end) => ({
  uri: uri(fsPath),
  range: { start: { line: start }, end: { line: end } },
});

test("a dragged-in file arrives as a plain uri", () => {
  const out = filesFromReferences([{ id: "vscode.file", value: uri("C:\\kiro-chat\\CLAUDE.md") }]);
  assert.deepEqual(out, [{ path: "C:\\kiro-chat\\CLAUDE.md" }]);
});

test("a selected range keeps its lines", () => {
  const out = filesFromReferences([
    { id: "vscode.selection", value: location("C:\\kiro-chat\\src\\usage.ts", 11, 39) },
  ]);
  // Editor lines are zero-based; people count from one.
  assert.deepEqual(out, [{ path: "C:\\kiro-chat\\src\\usage.ts", startLine: 12, endLine: 40 }]);
});

test("several references keep their order", () => {
  const out = filesFromReferences([
    { value: uri("C:\\a.ts") },
    { value: uri("C:\\b.ts") },
  ]);
  assert.deepEqual(out.map((f) => f.path), ["C:\\a.ts", "C:\\b.ts"]);
});

/** The same file dragged in and also #-mentioned should attach once. */
test("the same file referenced twice is only taken once", () => {
  const out = filesFromReferences([
    { value: uri("C:\\kiro-chat\\a.ts") },
    { value: uri("c:/kiro-chat/a.ts") },
  ]);
  assert.equal(out.length, 1);
});

/**
 * A whole-file reference and a range in the same file are different requests.
 * Collapsing them would silently drop the lines the user pointed at.
 */
test("a range in a file already attached whole is kept separately", () => {
  const out = filesFromReferences([
    { value: uri("C:\\a.ts") },
    { value: location("C:\\a.ts", 4, 9) },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[1].startLine, 5);
});

test("references with nothing on disk behind them are skipped", () => {
  const out = filesFromReferences([
    { id: "copilot.terminalSelection", value: "some selected text" },
    { value: undefined },
    { value: null },
    { value: { scheme: "untitled", fsPath: "Untitled-1" } },
    { value: uri("C:\\real.ts") },
  ]);
  assert.deepEqual(out, [{ path: "C:\\real.ts" }]);
});

test("no references at all is not an error", () => {
  assert.deepEqual(filesFromReferences([]), []);
  assert.deepEqual(filesFromReferences(undefined), []);
});

/** A single-line selection is a real range, not a whole file. */
test("a one-line selection is still a range", () => {
  const out = filesFromReferences([{ value: location("C:\\a.ts", 7, 7) }]);
  assert.deepEqual(out, [{ path: "C:\\a.ts", startLine: 8, endLine: 8 }]);
});
