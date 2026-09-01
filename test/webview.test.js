// Guards for the webview assets. These are the failures that show up as
// "the UI is buggy" and that nothing else in the build would catch.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.join(__dirname, "..");
const css = fs.readFileSync(path.join(root, "media", "chat.css"), "utf8");
const js = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");
const provider = fs.readFileSync(path.join(root, "src", "chatViewProvider.ts"), "utf8");

test("chat.js is valid JavaScript", () => {
  assert.doesNotThrow(() => new vm.Script(js, { filename: "chat.js" }));
});

/**
 * The panel toggles four elements with the hidden attribute. Every one of them
 * also has an author rule setting display, and an author rule beats the
 * browser's own [hidden] { display: none }. Without the override below, the
 * attach menu, the drop overlay, the usage strip and the chip row are all
 * painted permanently.
 */
test("the hidden attribute wins over our own display rules", () => {
  const override = css.match(/\[hidden\]\s*\{[^}]*display:\s*none\s*!important/);
  assert.ok(override, "chat.css must force [hidden] to display: none");

  for (const id of ["chips", "usage-bar", "dropzone", "attach-menu"]) {
    assert.ok(
      new RegExp(`\\.hidden\\s*=|${id}`).test(js),
      `chat.js should still manage #${id}`
    );
  }

  // The override has to sit above the component rules it is undoing.
  const overrideAt = css.indexOf(override[0]);
  for (const selector of [".chips {", ".usage-bar {", ".dropzone {", ".popup {"]) {
    const at = css.indexOf(selector);
    assert.ok(at > -1, `${selector} should exist`);
    assert.ok(at > overrideAt, `${selector} must come after the [hidden] override`);
  }
});

test("each toggled element has exactly one rule block", () => {
  for (const selector of [".dropzone", ".chips", ".usage-bar", ".popup"]) {
    const matches = css.match(new RegExp(`^\\${selector} \\{`, "gm")) ?? [];
    assert.equal(matches.length, 1, `${selector} is defined ${matches.length} times`);
  }
});

test("the menus are anchored inside a positioned parent", () => {
  // Otherwise they land over the message box, or spill out of a narrow sidebar.
  assert.match(css, /\.attach-wrap \{[^}]*position: relative/);
  assert.match(css, /\.composer \{[^}]*position: relative/);
  assert.match(provider, /<div class="attach-wrap">[\s\S]*?id="attach-menu"/);
});

test("the webview only loads files that exist under media", () => {
  const referenced = [...provider.matchAll(/media\("([^"]+)"\)/g)].map((m) => m[1]);
  assert.ok(referenced.length > 0, "the page should load its script and stylesheet");
  for (const file of referenced) {
    assert.ok(
      fs.existsSync(path.join(root, "media", file)),
      `media/${file} is referenced by the webview but missing`
    );
  }
});

test("Enter cannot start a second turn while Kiro is working", () => {
  const submit = js.slice(js.indexOf("function submit()"));
  assert.match(submit.slice(0, 200), /if \(busy\) return;/);
});
