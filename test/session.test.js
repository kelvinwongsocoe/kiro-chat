// Guards on KiroSession that cannot be unit tested, because the module imports
// vscode. Static, like the webview guards, and for the same reason: these are
// failures that only show up as "the UI lost something".
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const session = fs.readFileSync(
  path.join(__dirname, "..", "src", "kiroSession.ts"),
  "utf8"
);

/**
 * Neither session/new nor session/load carries a credit rate — verified
 * against kiro-cli 2.20.2, where the model list is id/name/description only.
 * The rates come from the separate `model` command, so any code path that
 * rebuilds the model list has to ask for them again or the rate badges
 * silently vanish for the rest of the session.
 */
test("every path that rebuilds the model list also fetches the credit rates", () => {
  const rebuilds = [...session.matchAll(/this\.readModels\(/g)];
  assert.ok(rebuilds.length >= 2, "expected session/new and session/load to both read models");

  for (const match of rebuilds) {
    // The enrichModels call should follow within the same method.
    const after = session.slice(match.index, match.index + 700);
    assert.match(
      after,
      /enrichModels\(\)/,
      `readModels at index ${match.index} rebuilds the list without refetching credit rates`
    );
  }
});

// ---------------------------------------------------------------------------
// One conversation, one turn at a time.
//
// `send` is reachable without going through the webview's disabled Send
// button — kiroChat.explainSelection calls it through the provider — so
// without this guard a right-click mid-turn put a second session/prompt on one
// session.
// ---------------------------------------------------------------------------
const Module = require("node:module");

/** Just enough of the vscode API for KiroSession to be constructed. */
function fakeVscode(config = {}) {
  class EventEmitter {
    constructor() {
      this.listeners = new Set();
      this.event = (listener) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
    }
    fire(value) {
      for (const listener of this.listeners) listener(value);
    }
    dispose() {
      this.listeners.clear();
    }
  }
  return {
    EventEmitter,
    ThemeColor: class {},
    OverviewRulerLane: { Right: 4 },
    Uri: { file: (p) => ({ fsPath: p, scheme: "file", toString: () => `file://${p}` }) },
    window: {
      createTextEditorDecorationType: () => ({ dispose() {} }),
      visibleTextEditors: [],
      activeTextEditor: undefined,
      showErrorMessage: () => Promise.resolve(undefined),
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({
        get: (key, fallback) => (key in config ? config[key] : fallback),
      }),
    },
    commands: { executeCommand: () => Promise.resolve(undefined) },
    languages: {},
  };
}

function loadKiroSession(config) {
  const api = fakeVscode(config);
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return api;
    return original.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}out${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(__dirname, "..", "out", "kiroSession.js")).KiroSession;
  } finally {
    Module._load = original;
  }
}

function noopEvents(overrides = {}) {
  return {
    onStatus() {},
    onText() {},
    onThought() {},
    onTool() {},
    onTurnEnd() {},
    onError() {},
    onNeedsSetup() {},
    onModels() {},
    onUsage() {},
    onCapabilities() {},
    ...overrides,
  };
}

const newSession = (overrides, config) =>
  new (loadKiroSession(config))({ appendLine() {} }, noopEvents(overrides));

/**
 * A refused turn has to reject, and reject *promptly*.
 *
 * Without the guard, `send` falls through to ensureReady(), which goes looking
 * for kiro-cli — and on a machine that has it, actually starts one. A
 * regression here would hang the run and leak an agent process rather than
 * failing, so the race is against a clock. Same shape as the stall guard in
 * directWriteReview.test.js.
 */
async function refused(run, ms = 2000) {
  const stalled = Symbol("stalled");
  const outcome = await Promise.race([
    run().then(
      () => "resolved",
      (err) => err
    ),
    new Promise((resolve) => setTimeout(() => resolve(stalled), ms).unref()),
  ]);
  assert.notEqual(outcome, stalled, "the turn was not refused — it started running");
  assert.ok(outcome instanceof Error, "the turn should have been refused");
  return outcome;
}

test("send refuses while Kiro is still working", async () => {
  const session = newSession();
  session.status = "busy";

  const err = await refused(() => session.send([{ type: "text", text: "and this" }]));
  assert.match(
    err.message,
    /still working on the last message/,
    "a command that bypasses the webview's disabled Send button must still be refused"
  );
});

/**
 * The check reads through the `currentStatus` getter rather than the field.
 * Testing `this.status` directly narrows its type for the rest of the method,
 * and the `finally` at the end legitimately expects it to be "busy" by then —
 * which TypeScript then rejects as an impossible comparison.
 */
test("the busy guard reads the status through the getter", () => {
  const send = session.slice(session.indexOf("async send(blocks"));
  assert.match(send.slice(0, 600), /this\.currentStatus === "busy"/);
});

test("turn_end reaches the panel", () => {
  const ended = [];
  const session = newSession({ onTurnEnd: (reason) => ended.push(reason) });

  session.handleNotification("session/update", {
    update: { sessionUpdate: "turn_end", stopReason: "end_turn" },
  });

  assert.deepEqual(ended, ["end_turn"]);
});

// ---------------------------------------------------------------------------
// How wide a permission to grant.
//
// ACP offers allow_once and allow_always side by side. The picker took
// whichever came first in the list, so auto-approval could hand out a standing
// permission when a single-use one was on the table — a broader grant than the
// setting's own description ("approve every tool Kiro asks to run") implies,
// and one the user never sees to correct.
// ---------------------------------------------------------------------------

/** The shape Kiro sends, with the broad option first — which is the trap. */
const permissionOptions = () => [
  { optionId: "a", name: "Always allow", kind: "allow_always" },
  { optionId: "b", name: "Allow once", kind: "allow_once" },
  { optionId: "c", name: "Reject", kind: "reject_once" },
];

test("auto-approval takes the narrowest grant on offer", async () => {
  const session = newSession(undefined, { autoApproveTools: true });

  const answer = await session.askPermission({
    toolCall: { title: "run a tool", kind: "other" },
    options: permissionOptions(),
  });

  assert.equal(answer.outcome.outcome, "selected");
  assert.equal(
    answer.outcome.optionId,
    "b",
    "allow_once was available; a standing permission must not be granted instead"
  );
});

/** Kiro's spelling of the kind varies; the preference must survive it. */
test("the narrowest grant is recognised however the kind is spelled", async () => {
  const session = newSession(undefined, { autoApproveTools: true });

  const answer = await session.askPermission({
    toolCall: { title: "run a tool", kind: "other" },
    options: [
      { optionId: "a", name: "Always", kind: "allow-always" },
      { optionId: "b", name: "Once", kind: "Allow-Once" },
    ],
  });
  assert.equal(answer.outcome.optionId, "b");
});

/** With only a broad option offered, that is still the one to take. */
test("a single standing option is still accepted when it is all there is", async () => {
  const session = newSession(undefined, { autoApproveTools: true });

  const answer = await session.askPermission({
    toolCall: { title: "run a tool", kind: "other" },
    options: [
      { optionId: "a", name: "Always allow", kind: "allow_always" },
      { optionId: "c", name: "Reject", kind: "reject_once" },
    ],
  });
  assert.equal(answer.outcome.optionId, "a");
});

/** Nothing to choose from is a cancellation, not a guess. */
test("no options at all cancels rather than inventing an answer", async () => {
  const session = newSession(undefined, { autoApproveTools: true });
  const answer = await session.askPermission({ toolCall: {}, options: [] });
  assert.equal(answer.outcome.outcome, "cancelled");
});
