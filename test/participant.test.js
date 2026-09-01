// `@kiro` in VS Code's own chat box.
//
// This is the whole reason the participant exists: a file dragged onto the
// native chat box arrives as a ChatPromptReference, and has to reach Kiro as
// something it can open. The panel can never do this — VS Code makes every
// webview non-interactive while a drag is in progress.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");

function load() {
  const captured = {};
  const api = {
    chat: {
      createChatParticipant: (id, handler) => {
        captured.id = id;
        captured.handler = handler;
        return { dispose() {}, set iconPath(v) {} };
      },
    },
    Uri: {
      file: (p) => ({ fsPath: p, scheme: "file", toString: () => `file:///${p.replace(/\\/g, "/")}` }),
      joinPath: (...parts) => ({ fsPath: parts.join("/") }),
    },
  };

  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return api;
    return original.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}out${path.sep}`)) delete require.cache[key];
    }
    const { registerParticipant } = require(path.join(root, "out", "participant.js"));
    return { registerParticipant, captured };
  } finally {
    Module._load = original;
  }
}

/** Records what the participant streamed back and what Kiro was asked. */
function harness(sessionBehaviour = {}) {
  const { registerParticipant, captured } = load();
  const seen = { blocks: null, markdown: [], progress: [], references: [] };

  const session = {
    cancel: () => {
      seen.cancelled = true;
    },
    sendTo: async (blocks, sink) => {
      seen.blocks = blocks;
      if (sessionBehaviour.throws) throw new Error(sessionBehaviour.throws);
      sink.onTool?.({ id: "1", title: "read src/usage.ts", status: "completed" });
      sink.onText("Here is what it does.");
    },
  };

  registerParticipant({ fsPath: root }, session, { appendLine: () => {} });

  const stream = {
    markdown: (v) => seen.markdown.push(String(v)),
    progress: (v) => seen.progress.push(String(v)),
    reference: (v) => seen.references.push(v.fsPath),
  };
  const token = { onCancellationRequested: () => ({ dispose() {} }) };

  return { run: (request) => captured.handler(request, {}, stream, token), seen, captured };
}

const uri = (fsPath) => ({ fsPath, scheme: "file" });

test("the participant registers under the id the manifest contributes", () => {
  const { captured } = harness();
  const pkg = require(path.join(root, "package.json"));
  assert.equal(captured.id, pkg.contributes.chatParticipants[0].id);
});

test("a dragged-in file reaches Kiro as something it can open", async () => {
  const h = harness();
  await h.run({
    prompt: "what does this do?",
    references: [{ id: "vscode.file", value: uri("C:\\kiro-chat\\src\\usage.ts") }],
  });

  const links = h.seen.blocks.filter((b) => b.type === "resource_link");
  assert.equal(links.length, 1, "the file must go across as a link Kiro can open");
  assert.match(links[0].uri, /usage\.ts$/);

  const text = h.seen.blocks.find((b) => b.type === "text").text;
  assert.match(text, /what does this do\?/, "the question is still asked");
  assert.match(text, /usage\.ts/, "and the file is named in the prompt");
});

test("the answer is streamed back as it arrives", async () => {
  const h = harness();
  await h.run({ prompt: "hello", references: [] });
  assert.deepEqual(h.seen.markdown, ["Here is what it does."]);
});

test("tools are reported as progress, not as part of the answer", async () => {
  const h = harness();
  await h.run({ prompt: "hello", references: [] });
  assert.equal(h.seen.progress.length, 1);
  assert.match(h.seen.progress[0], /read src\/usage\.ts/);
});

/** Attachments are echoed so one that did not survive the trip is visible. */
test("attached files are shown back to the user", async () => {
  const h = harness();
  await h.run({
    prompt: "review these",
    references: [{ value: uri("C:\\a.ts") }, { value: uri("C:\\b.ts") }],
  });
  assert.deepEqual(h.seen.references, ["C:\\a.ts", "C:\\b.ts"]);
});

test("a selected range is described by its lines", async () => {
  const h = harness();
  await h.run({
    prompt: "explain",
    references: [
      {
        value: {
          uri: uri("C:\\a.ts"),
          range: { start: { line: 11 }, end: { line: 39 } },
        },
      },
    ],
  });
  const text = h.seen.blocks.find((b) => b.type === "text").text;
  assert.match(text, /lines 12 to 40/);
});

test("an empty question asks for one instead of bothering Kiro", async () => {
  const h = harness();
  await h.run({ prompt: "   ", references: [] });
  assert.equal(h.seen.blocks, null, "Kiro should not have been asked anything");
  assert.match(h.seen.markdown.join(" "), /Ask me something/);
});

/** A file dropped with no question is a real request: review this. */
test("a file with no question still reaches Kiro", async () => {
  const h = harness();
  await h.run({ prompt: "", references: [{ value: uri("C:\\a.ts") }] });
  assert.ok(h.seen.blocks, "the attachment alone is enough to ask");
});

test("a failure is reported in the chat rather than thrown", async () => {
  const h = harness({ throws: "Kiro is still working on the last message." });
  const result = await h.run({ prompt: "hello", references: [] });
  assert.match(h.seen.markdown.join(" "), /still working on the last message/);
  assert.ok(result.errorDetails, "the chat should mark the turn as failed");
});
