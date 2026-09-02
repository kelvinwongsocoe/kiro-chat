const test = require("node:test");
const assert = require("node:assert/strict");

const { CHAT_MODES, applyChatMode, chatMode } = require("../out/chatModes.js");

test("all requested chat modes are available", () => {
  assert.deepEqual(
    CHAT_MODES.map((mode) => mode.id),
    ["default", "spec", "quick-spec", "bug-fix", "plan"]
  );
});

test("an unknown mode safely falls back to Default", () => {
  assert.equal(chatMode("not-a-mode").id, "default");
});

test("workflow modes add instructions without replacing the user's request", () => {
  const request = [{ type: "text", text: "Fix the upload failure" }];
  const blocks = applyChatMode(request, chatMode("bug-fix"));
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /Bug Fix mode/);
  assert.deepEqual(blocks[1], request[0]);
  assert.equal(applyChatMode(request, chatMode("default")), request);
});

test("Plan mode is marked read-only and explicitly forbids workspace changes", () => {
  const mode = chatMode("plan");
  assert.equal(mode.readOnly, true);
  assert.match(mode.instruction, /Do not modify files/);
});
