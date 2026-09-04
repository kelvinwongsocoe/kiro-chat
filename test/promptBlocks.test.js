// What Kiro actually receives.
//
// This is the last place the user's own text is handled before it leaves, so
// a mistake here means Kiro answers about something the user never showed it.
// None of it had a test until the context review that produced these.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildBlocks,
  canReadSelectionFrom,
  clipSelection,
  fenceFor,
  MAX_SELECTION_CHARS,
} = require("../out/promptBlocks");

const uri = (p) => "file:///" + String(p).replace(/\\/g, "/").replace(/^\//, "");
const build = (message, attachments, selection, include = true) =>
  buildBlocks(message, attachments, selection, include, uri);
const textOf = (blocks) => blocks.find((b) => b.type === "text").text;

const selectionOf = (over) => ({
  relativePath: "media/chat.js",
  fsPath: "C:\\kiro-chat\\media\\chat.js",
  languageId: "javascript",
  startLine: 26,
  endLine: 26,
  text: "let current = null;",
  hasSelection: true,
  ...over,
});

// ---- which documents a selection may come from -----------------------

/*
 * A diff, a git side, a search result or an output pane is a view of
 * something, not a file. The change-review diff was the one that bit: its URI
 * is `kiro-change-review:/<id>/chat.js (Working Tree)`, so clicking in the
 * review — which is how the keyboard shortcuts are used — and then asking a
 * question told Kiro it was looking at a path that exists nowhere.
 */
test("a selection is only read from something that is really a file", () => {
  for (const scheme of ["file", "untitled", "vscode-remote", "vscode-vfs"]) {
    assert.equal(canReadSelectionFrom(scheme), true, `${scheme} should be readable`);
  }
  for (const scheme of [
    "kiro-change-review",
    "git",
    "gitfs",
    "output",
    "search-editor",
    "vscode-scm",
    "",
    undefined,
  ]) {
    assert.equal(canReadSelectionFrom(scheme), false, `${scheme} must not be read`);
  }
});

// ---- code that contains a fence --------------------------------------

/*
 * Markdown ends a fenced block at the first line of at least as many
 * backticks as opened it. Selected code containing ``` — a markdown file, a
 * template literal, a Python docstring — therefore escaped the block, and
 * everything after it was read as prose rather than as the user's code.
 */
test("selected code containing a fence cannot break out of the block", () => {
  const code = ["const doc = `", "```js", "console.log(1)", "```", "`;"].join("\n");
  const blocks = build("what is this?", [], selectionOf({ text: code }));
  const body = textOf(blocks);

  const fence = fenceFor(code);
  assert.ok(fence.length > 3, `expected a longer fence, got ${fence.length} backticks`);

  // The opening fence must not be matched by anything inside the code.
  const lines = body.split("\n");
  const opens = lines.findIndex((line) => line.startsWith(fence));
  const closes = lines.length - 1 - [...lines].reverse().findIndex((line) => line === fence);
  assert.ok(opens >= 0 && closes > opens, "the block must open and close");
  for (const line of code.split("\n")) {
    const at = lines.indexOf(line);
    assert.ok(at > opens && at < closes, `"${line}" escaped the fenced block`);
  }
});

test("ordinary code still gets an ordinary fence", () => {
  assert.equal(fenceFor("let current = null;"), "```");
  assert.equal(fenceFor(""), "```");
  // One longer than the longest run present, so four beats three.
  assert.equal(fenceFor("a ``` b"), "````");
  assert.equal(fenceFor("a ````` b"), "``````");
});

// ---- a selection too long to send ------------------------------------

/*
 * The text is cut at 12k characters. Saying "lines 26 to 480" over a block
 * holding only the first part of that claims Kiro has all of it, so an answer
 * about the end of the selection is about code it never saw.
 */
test("a cut selection says it was cut", () => {
  const long = "x".repeat(MAX_SELECTION_CHARS + 500);
  const clipped = clipSelection(long);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.text.length, MAX_SELECTION_CHARS);

  const body = textOf(
    build("explain", [], selectionOf({ text: clipped.text, endLine: 480, truncated: true }))
  );
  assert.match(body, /lines 26 to 480 \(only the first \d+ characters are shown\)/);
});

test("a selection that fits is not called cut", () => {
  const clipped = clipSelection("short");
  assert.equal(clipped.truncated, false);
  const body = textOf(build("explain", [], selectionOf({ truncated: false })));
  assert.match(body, /lines 26 to 26:/);
  assert.doesNotMatch(body, /characters are shown/);
});

// ---- the rest of the message ----------------------------------------

test("attached files are named in the text and linked as resources", () => {
  const blocks = build(
    "have a look",
    [
      { id: "1", kind: "file", label: "src/a.ts", path: "C:\\w\\src\\a.ts" },
      { id: "2", kind: "folder", label: "src", path: "C:\\w\\src" },
    ],
    undefined
  );
  const body = textOf(blocks);
  assert.match(body, /Files to look at:\n- C:\\w\\src\\a\.ts/);
  assert.match(body, /Folders to look at:\n- C:\\w\\src/);

  const links = blocks.filter((b) => b.type === "resource_link");
  assert.deepEqual(links.map((b) => b.name), ["src/a.ts", "src"]);
});

test("an image rides along as its own block, not as text", () => {
  const blocks = build("what is this?", [
    { id: "3", kind: "image", label: "shot.png", data: "AAAA", mimeType: "image/png" },
  ]);
  const image = blocks.find((b) => b.type === "image");
  assert.equal(image.data, "AAAA");
  assert.equal(image.mimeType, "image/png");
  assert.doesNotMatch(textOf(blocks), /AAAA/, "the payload must not also go as text");
});

test("an attachment with nothing behind it is left out", () => {
  const blocks = build("hi", [
    { id: "4", kind: "file", label: "gone.ts" },
    { id: "5", kind: "image", label: "empty.png" },
  ]);
  assert.equal(blocks.filter((b) => b.type !== "text").length, 0);
  assert.equal(textOf(blocks), "hi");
});

test("switching the selection off leaves it out entirely", () => {
  const body = textOf(build("hello", [], selectionOf(), false));
  assert.equal(body, "hello");
});

test("with nothing highlighted, Kiro is told the file and not given a block", () => {
  const body = textOf(
    build("what does this do?", [], selectionOf({ hasSelection: false, text: "" }))
  );
  assert.match(body, /I am looking at media\/chat\.js\./);
  assert.doesNotMatch(body, /```/, "there is no code to fence");
});

// ---- one mention per file --------------------------------------------

const openFile = {
  id: "active:C:\\kiro-chat\\media\\chat.js",
  kind: "file",
  source: "active",
  label: "media/chat.js",
  path: "C:\\kiro-chat\\media\\chat.js",
};
const other = { id: "6", kind: "file", label: "src/usage.ts", path: "C:\\w\\src\\usage.ts" };

/*
 * The file being looked at was listed by its absolute path under "Files to
 * look at" and then again, relatively, by the selection block —
 * `C:\kiro-chat\media\chat.js` and `media/chat.js`, two spellings that do not
 * look like one file. Kiro was being handed one file as two.
 */
test("the file the selection is in is named once, not twice", () => {
  const body = textOf(build("why slow?", [openFile], selectionOf()));
  assert.match(body, /I am looking at media\/chat\.js, lines 26 to 26:/);
  assert.doesNotMatch(body, /Files to look at:/, "the selection block already names it");
  assert.doesNotMatch(body, /kiro-chat\\media\\chat\.js/, "and names it only the once");
});

/** Losing the path from the text must not lose the link Kiro opens it by. */
test("the link survives even when the text mention does not", () => {
  const blocks = build("why slow?", [openFile], selectionOf());
  const links = blocks.filter((b) => b.type === "resource_link");
  assert.deepEqual(links.map((b) => b.name), ["media/chat.js"]);
});

test("a file attached by hand is deduplicated the same way", () => {
  const byHand = { id: "7", kind: "file", label: "media/chat.js", path: openFile.path };
  const body = textOf(build("why slow?", [byHand], selectionOf()));
  assert.doesNotMatch(body, /Files to look at:/, "same file, same rule");
});

test("the other files you attached are untouched by it", () => {
  const body = textOf(build("why slow?", [other, openFile], selectionOf()));
  assert.match(body, /Files to look at:\n- C:\\w\\src\\usage\.ts/);
  assert.match(body, /I am looking at media\/chat\.js/);
});

/*
 * Listed among the files the user picked, the file that merely happens to be
 * focused read as one of them — so "update these files" quietly took in
 * whatever tab was open. It only needs saying when the selection block is not
 * already saying it, which means with `kiroChat.sendSelection` off.
 */
test("the file that is merely open is not listed as one you chose", () => {
  const body = textOf(build("update these", [other, openFile], selectionOf(), false));
  assert.match(body, /Files to look at:\n- C:\\w\\src\\usage\.ts/);
  // Not as a bullet under that heading: it is named below, as what it is.
  assert.doesNotMatch(
    body,
    /^- C:\\kiro-chat\\media\\chat\.js$/m,
    "the open file is not one of the files to look at"
  );
  assert.match(body, /The file I have open is C:\\kiro-chat\\media\\chat\.js\./);
});

test("with the selection on, the open file needs no line of its own", () => {
  const body = textOf(build("update these", [other, openFile], selectionOf()));
  assert.doesNotMatch(body, /The file I have open is/, "the selection block says it");
});

test("a spelling difference does not defeat the deduplication", () => {
  const body = textOf(
    build("why slow?", [{ ...openFile, path: "c:/KIRO-CHAT/media/chat.js" }], selectionOf())
  );
  assert.doesNotMatch(body, /Files to look at:/);
});
