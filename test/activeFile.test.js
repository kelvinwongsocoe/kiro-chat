// The file you are looking at rides along with your message, the way Copilot
// Chat does it. The fiddly part is not adding it twice when you have already
// attached the same file by hand — and Windows spells a path several ways, so
// a naive comparison would attach it again and pay for it twice.
const test = require("node:test");
const assert = require("node:assert/strict");

const { attachmentsForMessage, activeFileAttachment } = require("../out/activeFile");
const { samePath } = require("../out/paths");

const file = (path, label) => ({ id: path, kind: "file", label, path });

test("the file you are looking at is added", () => {
  const out = attachmentsForMessage([], { path: "C:\\kiro-chat\\CLAUDE.md", label: "CLAUDE.md" }, true);
  assert.equal(out.length, 1);
  assert.equal(out[0].path, "C:\\kiro-chat\\CLAUDE.md");
  assert.equal(out[0].kind, "file");
});

test("dismissing it leaves the message alone", () => {
  const mine = [file("C:\\a.ts", "a.ts")];
  const out = attachmentsForMessage(mine, { path: "C:\\kiro-chat\\CLAUDE.md", label: "CLAUDE.md" }, false);
  assert.deepEqual(out, mine);
});

test("with no file focused nothing is added", () => {
  const mine = [file("C:\\a.ts", "a.ts")];
  assert.deepEqual(attachmentsForMessage(mine, undefined, true), mine);
});

test("it goes after whatever you attached yourself", () => {
  const mine = [file("C:\\a.ts", "a.ts"), file("C:\\b.ts", "b.ts")];
  const out = attachmentsForMessage(mine, { path: "C:\\c.ts", label: "c.ts" }, true);
  assert.deepEqual(out.map((a) => a.path), ["C:\\a.ts", "C:\\b.ts", "C:\\c.ts"]);
});

/**
 * Attaching the same file twice sends it to Kiro twice. Windows lets the same
 * file be written several ways, so this has to compare properly rather than
 * by string.
 */
test("a file you already attached is not attached again", () => {
  for (const spelling of [
    "C:\\kiro-chat\\CLAUDE.md",
    "c:/kiro-chat/CLAUDE.md",
    "C:/kiro-chat\\CLAUDE.md",
    "c:\\KIRO-CHAT\\claude.md",
  ]) {
    const mine = [file(spelling, "CLAUDE.md")];
    const out = attachmentsForMessage(mine, { path: "C:\\kiro-chat\\CLAUDE.md", label: "CLAUDE.md" }, true);
    assert.equal(out.length, 1, `"${spelling}" should have counted as already attached`);
  }
});

test("a different file that starts the same way is still added", () => {
  const mine = [file("C:\\kiro-chat\\CLAUDE.md.bak", "CLAUDE.md.bak")];
  const out = attachmentsForMessage(mine, { path: "C:\\kiro-chat\\CLAUDE.md", label: "CLAUDE.md" }, true);
  assert.equal(out.length, 2);
});

test("the attachment it builds is a real one the rest of the code understands", () => {
  const made = activeFileAttachment({ path: "C:\\kiro-chat\\src\\usage.ts", label: "src/usage.ts" });
  assert.equal(made.kind, "file");
  assert.equal(made.label, "src/usage.ts");
  assert.equal(made.path, "C:\\kiro-chat\\src\\usage.ts");
  assert.ok(made.id, "it needs an id so the chip can be removed");
});

// ---- path comparison -------------------------------------------------

test("the same file spelled differently is the same file", () => {
  assert.equal(samePath("C:\\a\\b.ts", "c:/a/b.ts"), true);
  assert.equal(samePath("C:/a/b.ts/", "C:\\a\\b.ts"), true);
  assert.equal(samePath("C:\\a\\b.ts", "C:\\a\\c.ts"), false);
  assert.equal(samePath("C:\\a\\b", "C:\\a\\b-old"), false);
});

test("a missing path never matches anything", () => {
  assert.equal(samePath(undefined, "C:\\a"), false);
  assert.equal(samePath("C:\\a", undefined), false);
  assert.equal(samePath(undefined, undefined), false);
});
