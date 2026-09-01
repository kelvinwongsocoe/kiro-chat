// Turning whatever a drag put on the clipboard into real paths.
//
// VS Code offers dragged Explorer items under several formats at once, each
// shaped differently — a newline list of file:// URIs, a JSON array of encoded
// strings, a bare Windows path. Reading only one of them is why a drop can
// look like it did nothing.
const test = require("node:test");
const assert = require("node:assert/strict");

const { parseDroppedPaths } = require("../out/dropped");

test("a uri-list becomes paths", () => {
  const out = parseDroppedPaths([
    "file:///c%3A/kiro-chat/src/usage.ts\r\nfile:///c%3A/kiro-chat/CLAUDE.md",
  ]);
  assert.deepEqual(out, ["c:\\kiro-chat\\src\\usage.ts", "c:\\kiro-chat\\CLAUDE.md"]);
});

test("comment lines in a uri-list are ignored", () => {
  const out = parseDroppedPaths(["# this is a comment\nfile:///c%3A/a.ts"]);
  assert.deepEqual(out, ["c:\\a.ts"]);
});

/** The `resourceurls` format is a JSON array of encoded URI strings. */
test("a JSON array of encoded urls is unpacked", () => {
  const out = parseDroppedPaths([
    JSON.stringify(["file%3A%2F%2F%2Fc%253A%2Fkiro-chat%2Fsrc%2Fhistory.ts"]),
  ]);
  assert.deepEqual(out, ["c:\\kiro-chat\\src\\history.ts"]);
});

test("a JSON array of plain paths is unpacked too", () => {
  const out = parseDroppedPaths([JSON.stringify(["C:\\kiro-chat\\a.ts", "C:\\kiro-chat\\b.ts"])]);
  assert.deepEqual(out, ["C:\\kiro-chat\\a.ts", "C:\\kiro-chat\\b.ts"]);
});

test("a bare windows path is taken as-is", () => {
  assert.deepEqual(parseDroppedPaths(["C:\\kiro-chat\\CLAUDE.md"]), ["C:\\kiro-chat\\CLAUDE.md"]);
});

test("spaces and unicode survive the round trip", () => {
  const out = parseDroppedPaths(["file:///c%3A/my%20docs/caf%C3%A9.md"]);
  assert.deepEqual(out, ["c:\\my docs\\café.md"]);
});

/**
 * Several formats describe the same drag, so the same file arrives more than
 * once. Attaching it twice sends it to Kiro twice.
 */
test("the same file offered by several formats is only taken once", () => {
  const out = parseDroppedPaths([
    "file:///c%3A/kiro-chat/a.ts",
    JSON.stringify(["file:///c%3A/kiro-chat/a.ts"]),
    "c:\\kiro-chat\\a.ts",
  ]);
  assert.equal(out.length, 1);
});

/** Only things on disk can be attached. */
test("things that are not files on disk are dropped", () => {
  const out = parseDroppedPaths([
    "untitled:Untitled-1",
    "https://example.com/thing.ts",
    "vscode-userdata:/User/settings.json",
    "file:///c%3A/real.ts",
  ]);
  assert.deepEqual(out, ["c:\\real.ts"]);
});

test("empty and malformed input is survivable", () => {
  assert.deepEqual(parseDroppedPaths([]), []);
  assert.deepEqual(parseDroppedPaths(["", "   ", "\n\n"]), []);
  assert.deepEqual(parseDroppedPaths(["[not json"]), []);
  assert.deepEqual(parseDroppedPaths([undefined, null]), []);
});

test("a plain-text drag of ordinary prose is not mistaken for a path", () => {
  assert.deepEqual(parseDroppedPaths(["have a look at this please"]), []);
});
