const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const { applySelectedLines, buildReviewDiff } = require(path.join(
  __dirname,
  "..",
  "out",
  "lineDiff.js"
));

test("accepting all or no changed lines reproduces the exact proposed or original file", () => {
  const cases = [
    ["", "first\n"],
    ["first\n", ""],
    ["one\ntwo\nthree\n", "one\nsecond\nthree\nfour\n"],
    ["one\r\ntwo", "one\r\nsecond\r\n"],
  ];

  for (const [before, after] of cases) {
    const diff = buildReviewDiff(before, after);
    const all = new Set(Array.from({ length: diff.changeCount }, (_, index) => index));
    assert.equal(applySelectedLines(before, after, diff, all), after);
    assert.equal(applySelectedLines(before, after, diff, new Set()), before);
  }
});

test("added and removed lines can be applied independently", () => {
  const before = "one\nold\nkeep\nremove\n";
  const after = "one\nnew\nkeep\nadd\n";
  const diff = buildReviewDiff(before, after);
  const selected = new Set(
    diff.rows
      .filter(
        (row) =>
          (row.kind === "delete" && row.text === "old") ||
          (row.kind === "insert" && row.text === "new")
      )
      .map((row) => row.changeId)
  );

  assert.equal(applySelectedLines(before, after, diff, selected), "one\nnew\nkeep\nremove\n");
});

test("distant edits are separate hunks and nearby edits share one", () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}\n`).join("");
  const lines = before.split("\n");
  lines[1] = "changed 2";
  lines[3] = "changed 4";
  lines[17] = "changed 18";
  const after = lines.join("\n");
  const diff = buildReviewDiff(before, after, 2);

  assert.equal(diff.hunks.length, 2);
  const ids = diff.hunks.flatMap((hunk) =>
    hunk.rows.filter((row) => row.changeId !== undefined).map((row) => row.changeId)
  );
  assert.equal(ids.length, diff.changeCount, "a changed line must appear in exactly one hunk");
  assert.equal(new Set(ids).size, ids.length);
});

test("zero-context review mode splits nearby contiguous change blocks", () => {
  const before = "one\ntwo\nthree\nfour\nfive\n";
  const after = "one\nchanged two\nthree\nchanged four\nfive\n";
  const diff = buildReviewDiff(before, after, 0);

  assert.equal(diff.hunks.length, 2);
});

test("line-ending-only edits remain reviewable and apply exactly", () => {
  const before = "one\r\ntwo\r\n";
  const after = "one\ntwo\n";
  const diff = buildReviewDiff(before, after);

  assert.ok(diff.changeCount > 0);
  assert.ok(diff.rows.some((row) => row.ending === "CRLF"));
  assert.ok(diff.rows.some((row) => row.ending === "LF"));
  const all = new Set(Array.from({ length: diff.changeCount }, (_, index) => index));
  assert.equal(applySelectedLines(before, after, diff, all), after);
});
