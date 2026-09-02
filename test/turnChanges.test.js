// After a turn that edited files, the chat offers to keep or undo the lot.
//
// Working out what "the lot" is means comparing every file the turn touched
// against the snapshot taken before Kiro ran. A file Kiro wrote and then wrote
// back, or one whose review was rejected, did not change and must not appear —
// offering to undo something that never happened is worse than saying nothing.
const test = require("node:test");
const assert = require("node:assert/strict");

const { changedSinceBaseline, describeChange } = require("../out/turnChanges");

const snap = (full, exists, content) => ({ full, exists, content });

test("a file whose contents changed is reported", () => {
  const out = changedSinceBaseline(
    [snap("C:\\p\\a.ts", true, "old")],
    (full) => ({ full, exists: true, content: "new" })
  );
  assert.deepEqual(out.map((c) => c.path), ["C:\\p\\a.ts"]);
  assert.equal(out[0].kind, "modified");
});

test("a file Kiro created is reported as created", () => {
  const out = changedSinceBaseline(
    [snap("C:\\p\\new.ts", false, "")],
    () => ({ full: "C:\\p\\new.ts", exists: true, content: "hello" })
  );
  assert.equal(out[0].kind, "created");
});

test("a file Kiro deleted is reported as deleted", () => {
  const out = changedSinceBaseline(
    [snap("C:\\p\\gone.ts", true, "bye")],
    () => ({ full: "C:\\p\\gone.ts", exists: false, content: "" })
  );
  assert.equal(out[0].kind, "deleted");
});

/**
 * A rejected review restores the original, and Kiro sometimes rewrites a file
 * with what it already contained. Neither is a change.
 */
test("a file that ended up identical is not reported", () => {
  const out = changedSinceBaseline(
    [snap("C:\\p\\same.ts", true, "unchanged")],
    (full) => ({ full, exists: true, content: "unchanged" })
  );
  assert.deepEqual(out, []);
});

test("a file that never existed and still does not is not reported", () => {
  const out = changedSinceBaseline(
    [snap("C:\\p\\never.ts", false, "")],
    (full) => ({ full, exists: false, content: "" })
  );
  assert.deepEqual(out, []);
});

test("a file that cannot be read now is left out rather than guessed at", () => {
  const out = changedSinceBaseline([snap("C:\\p\\x.ts", true, "old")], () => undefined);
  assert.deepEqual(out, []);
});

test("nothing touched means nothing to offer", () => {
  assert.deepEqual(changedSinceBaseline([], () => undefined), []);
  assert.deepEqual(changedSinceBaseline(undefined, () => undefined), []);
});

// ---- what the card says ----------------------------------------------

test("one file is named, not counted", () => {
  assert.equal(describeChange([{ path: "a", label: "src/usage.ts", kind: "modified" }]),
    "Kiro changed src/usage.ts.");
});

test("a handful of files are counted", () => {
  const files = [
    { path: "a", label: "src/a.ts", kind: "modified" },
    { path: "b", label: "src/b.ts", kind: "created" },
  ];
  assert.equal(describeChange(files), "Kiro changed 2 files.");
});

test("no files has nothing to say", () => {
  assert.equal(describeChange([]), "");
});
