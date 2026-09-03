// Naming the steps Kiro reports.
//
// Every payload here was captured by driving `kiro-cli acp` directly against
// this repo, not read from docs — see the probe described in CLAUDE.md.
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const root = path.join(__dirname, "..");

// kiroSession imports vscode, so stub it for the one pure function we want.
function loadSession() {
  const original = Module._load;
  Module._load = function (request, ...args) {
    if (request === "vscode") {
      return {
        workspace: { getConfiguration: () => ({ get: () => undefined }), workspaceFolders: [] },
        window: {},
        Uri: { file: (p) => ({ fsPath: p }) },
        EventEmitter: class {
          constructor() {
            this.event = () => ({ dispose() {} });
          }
          fire() {}
          dispose() {}
        },
      };
    }
    return original.call(this, request, ...args);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}out${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(root, "out", "kiroSession.js"));
  } finally {
    Module._load = original;
  }
}

const { describeTool, isSessionUpdate } = loadSession();

/*
 * Kiro sends its updates under two method names, and only one of them was
 * accepted.
 *
 * Captured from a whole turn against kiro-cli 2.20.2: `session/update` carries
 * `tool_call`, `tool_call_update` and every `agent_message_chunk`, while
 * `_kiro.dev/session/update` carries the `tool_call_chunk` — the first word
 * that a step is starting. Rejecting the prefixed name dropped every one of
 * those at the door, which is precisely the window where the panel has nothing
 * to say but "Working…".
 */
test("both spellings of a session update are accepted", () => {
  for (const method of [
    "session/update",
    "_kiro.dev/session/update",
    "kiro.dev/session/update",
    "session/notification",
    "_kiro.dev/session/notification",
  ]) {
    assert.equal(isSessionUpdate(method), true, `${method} must be handled`);
  }
});

test("notifications that are not session updates are still refused", () => {
  for (const method of [
    "_kiro.dev/metadata",
    "_kiro.dev/subagent/list_update",
    "_kiro.dev/commands/available",
    "initialize",
    "",
  ]) {
    assert.equal(isSessionUpdate(method), false, `${method} must not be treated as an update`);
  }
});

/*
 * The three notifications kiro-cli 2.20.2 sends for one `read`, in order.
 * The first has no status and a title that is only the kind.
 */
const CHUNK = {
  sessionUpdate: "tool_call_chunk",
  toolCallId: "toolu_bdrk_01BJ",
  title: "read",
  kind: "read",
};
const CALL = {
  sessionUpdate: "tool_call",
  toolCallId: "toolu_bdrk_01BJ",
  title: "Reading package.json:1",
  kind: "read",
  locations: [{ path: "C:\\kiro-chat\\package.json" }],
  rawInput: {
    __tool_use_purpose: "Read package.json to get the version string.",
    operations: [{ mode: "Line", path: "C:\\kiro-chat\\package.json" }],
  },
};
const UPDATE = { ...CALL, sessionUpdate: "tool_call_update", status: "completed" };

test("the first notification is given a verb, not the bare kind", () => {
  const step = describeTool(CHUNK);
  assert.equal(step.title, "Reading", 'showing "read" is worse than showing a verb');
  assert.equal(step.status, "running", "only tool_call_update carries a status");
  assert.equal(step.id, "toolu_bdrk_01BJ");
});

test("a real title always wins over the verb table", () => {
  assert.equal(describeTool(CALL).title, "Reading package.json:1");
  assert.equal(describeTool(UPDATE).title, "Reading package.json:1");
});

test("all three notifications describe the same step", () => {
  const ids = [CHUNK, CALL, UPDATE].map((u) => describeTool(u).id);
  assert.equal(new Set(ids).size, 1, "or the panel would draw three rows for one step");
});

test("the status is carried through when Kiro sends one", () => {
  assert.equal(describeTool(UPDATE).status, "completed");
  assert.equal(describeTool({ ...UPDATE, status: "failed" }).status, "failed");
});

/*
 * Kiro says why it is running each step. That is what unfolding the list is
 * for: the title says what, this says what for.
 */
test("Kiro's own note on why is carried through", () => {
  assert.equal(describeTool(CALL).purpose, "Read package.json to get the version string.");
  assert.equal(describeTool(CHUNK).purpose, undefined, "the first notification has none");
});

test("kinds without a verb of their own are at least capitalised", () => {
  assert.equal(describeTool({ title: "frobnicate", kind: "frobnicate" }).title, "Frobnicate");
});

test("a shell step falls back to the command it is running", () => {
  const step = describeTool({ kind: "execute", rawInput: { command: "npm test" } });
  assert.equal(step.title, "npm test");
});

test("a notification with nothing usable still names itself", () => {
  const step = describeTool({});
  assert.equal(step.title, "Working");
  assert.equal(step.status, "running");
  assert.ok(step.id, "and it must still have an id, or rows would collide");
});
