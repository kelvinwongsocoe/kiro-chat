// Chat history. The fiddly parts are all here: naming a chat from whatever
// the user happened to type first, deciding what "Today" means, and telling
// two Windows paths apart when they spell the same folder differently.
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  titleFrom,
  groupByDay,
  forWorkspace,
  pruneHistory,
  upsertRecord,
} = require("../out/history");

// 2026-09-02 14:41 local time, the day this was written.
const NOW = new Date(2026, 8, 2, 14, 41).getTime();
const at = (y, m, d, h = 12, min = 0) => new Date(y, m, d, h, min).getTime();

// ---- naming a chat ---------------------------------------------------

test("a chat is named after the first thing the user said", () => {
  const title = titleFrom([
    { role: "user", text: "Why does the usage strip stay blank?" },
    { role: "agent", text: "Because the meter arrives two ways." },
  ]);
  assert.equal(title, "Why does the usage strip stay blank?");
});

test("only the first line is used, however long the message", () => {
  const title = titleFrom([
    { role: "user", text: "Fix the setup screen\n\nIt shows three blue buttons\nand the footer reads badly." },
  ]);
  assert.equal(title, "Fix the setup screen");
});

test("a very long first line is cut rather than allowed to run", () => {
  const title = titleFrom([{ role: "user", text: "a".repeat(200) }]);
  assert.ok(title.length <= 60, `title was ${title.length} chars`);
  assert.match(title, /…$/, "a cut title should say it was cut");
});

test("a chat with nothing worth naming falls back to a placeholder", () => {
  assert.equal(titleFrom([]), "New chat");
  assert.equal(titleFrom([{ role: "agent", text: "Hello" }]), "New chat");
  assert.equal(titleFrom([{ role: "user", text: "   \n  " }]), "New chat");
});

/** An attachment-only message is a real message and should still name the chat. */
test("a message that is only attachments is named by them", () => {
  const title = titleFrom([
    { role: "user", text: "", attachments: [{ kind: "image", label: "screenshot.png" }] },
  ]);
  assert.equal(title, "screenshot.png");
});

// ---- grouping by day -------------------------------------------------

test("chats are grouped into Today, Yesterday and then dates", () => {
  const groups = groupByDay(
    [
      { id: "a", updatedAt: at(2026, 8, 2, 9, 0) },
      { id: "b", updatedAt: at(2026, 8, 1, 16, 0) },
      { id: "c", updatedAt: at(2026, 7, 28, 11, 0) },
    ],
    NOW
  );
  assert.deepEqual(groups.map((g) => g.label).slice(0, 2), ["Today", "Yesterday"]);
  assert.deepEqual(groups.map((g) => g.records.map((r) => r.id)), [["a"], ["b"], ["c"]]);

  // Older chats get a real date. The wording follows the reader's locale, so
  // assert what it must contain rather than pinning one language's word order.
  const older = groups[2].label;
  assert.notEqual(older, "Today");
  assert.notEqual(older, "Yesterday");
  assert.match(older, /2026/, `expected a dated label, got "${older}"`);
  assert.match(older, /28/, `expected the day of the month, got "${older}"`);
});

/**
 * "Today" is a calendar day, not the last 24 hours. A chat at 11pm yesterday
 * is Yesterday even though it is only twelve hours ago.
 */
test("the day boundary is midnight, not a rolling 24 hours", () => {
  const groups = groupByDay(
    [
      { id: "late", updatedAt: at(2026, 8, 1, 23, 59) },
      { id: "early", updatedAt: at(2026, 8, 2, 0, 1) },
    ],
    NOW
  );
  const labels = Object.fromEntries(
    groups.flatMap((g) => g.records.map((r) => [r.id, g.label]))
  );
  assert.equal(labels.late, "Yesterday");
  assert.equal(labels.early, "Today");
});

test("newest chats come first, inside a group and across groups", () => {
  const groups = groupByDay(
    [
      { id: "morning", updatedAt: at(2026, 8, 2, 9, 0) },
      { id: "older", updatedAt: at(2026, 7, 20) },
      { id: "afternoon", updatedAt: at(2026, 8, 2, 14, 0) },
    ],
    NOW
  );
  assert.equal(groups[0].label, "Today");
  assert.deepEqual(groups[0].records.map((r) => r.id), ["afternoon", "morning"]);
  assert.equal(groups.at(-1).records[0].id, "older");
});

test("no chats means no groups, not an empty Today", () => {
  assert.deepEqual(groupByDay([], NOW), []);
});

// ---- which folder a chat belongs to ----------------------------------

/**
 * Kiro binds a session to its cwd, so a chat from another project cannot
 * meaningfully resume here. Windows spells the same folder several ways, and
 * missing a match would silently hide the user's own chats.
 */
test("a folder matches however Windows spelled it", () => {
  const records = [
    { id: "a", cwd: "C:\\kiro-chat" },
    { id: "b", cwd: "c:/kiro-chat/" },
    { id: "c", cwd: "C:/kiro-chat" },
    { id: "d", cwd: "C:\\other-project" },
  ];
  const mine = forWorkspace(records, "C:\\kiro-chat");
  assert.deepEqual(mine.map((r) => r.id), ["a", "b", "c"]);
});

test("a folder never matches a different one that starts the same way", () => {
  const records = [{ id: "sneaky", cwd: "C:\\kiro-chat-old" }];
  assert.deepEqual(forWorkspace(records, "C:\\kiro-chat"), []);
});

test("with no folder open nothing is claimed to belong to it", () => {
  assert.deepEqual(forWorkspace([{ id: "a", cwd: "C:\\x" }], undefined), []);
});

// ---- keeping the list from growing forever ---------------------------

test("only the newest chats are kept", () => {
  const records = [
    { id: "old", updatedAt: at(2026, 7, 1) },
    { id: "newest", updatedAt: at(2026, 8, 2) },
    { id: "middle", updatedAt: at(2026, 8, 1) },
  ];
  assert.deepEqual(pruneHistory(records, 2).map((r) => r.id), ["newest", "middle"]);
});

test("pruning a short list leaves it alone", () => {
  const records = [{ id: "a", updatedAt: 1 }];
  assert.deepEqual(pruneHistory(records, 10).map((r) => r.id), ["a"]);
});

// ---- saving a chat ---------------------------------------------------

test("saving a chat again replaces it instead of adding a duplicate", () => {
  const first = { id: "x", updatedAt: 1, messageCount: 2 };
  const records = upsertRecord([first], { id: "x", updatedAt: 5, messageCount: 6 });
  assert.equal(records.length, 1);
  assert.equal(records[0].messageCount, 6);
});

test("a new chat joins the others without disturbing them", () => {
  const records = upsertRecord([{ id: "a", updatedAt: 1 }], { id: "b", updatedAt: 2 });
  assert.deepEqual(records.map((r) => r.id).sort(), ["a", "b"]);
});
