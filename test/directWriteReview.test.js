const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

const root = path.join(__dirname, "..");

/** A stand-in for format-on-save: Prettier normalising quote style. */
const formatter = (text) => text.replace(/'/g, '"');

function fakeVscode(workspaceRoot, reviewAction, reviewWrites = true, formatOnSave = false) {
  const roots = Array.isArray(workspaceRoot) ? workspaceRoot : [workspaceRoot];
  const commands = new Map();
  const visibleListeners = new Set();
  const closeDocumentListeners = new Set();
  const changeDocumentListeners = new Set();
  let contentProvider;
  let codeLensProvider;

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

  class Uri {
    constructor(scheme, uriPath, fsPath) {
      this.scheme = scheme;
      this.path = uriPath;
      this.fsPath = fsPath;
    }
    toString() {
      return `${this.scheme}:${this.path}`;
    }
    static parse(value) {
      const url = new URL(value);
      return new Uri(url.protocol.slice(0, -1), url.pathname, fileURLToPath(url));
    }
    static from(parts) {
      return new Uri(parts.scheme, parts.path, parts.path);
    }
    static file(fsPath) {
      return new Uri("file", String(fsPath).replace(/\\/g, "/"), fsPath);
    }
  }

  /*
   * VS Code's own write path, modelled well enough to tell it apart from a
   * raw fs.writeFile: a workspace edit goes on the document's undo stack, a
   * disk write does not. `editorWrites` records which files took that route.
   */
  const pending = new Map();
  const api = {
    reviewSnapshots: [],
    editorWrites: [],
    WorkspaceEdit: class {
      constructor() {
        this.operations = [];
      }
      replace(uri, _range, content) {
        this.operations.push({ uri, content });
      }
      createFile(uri, options) {
        this.operations.push({ uri, content: String(options?.contents ?? "") });
      }
    },
    Position: class {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    workspace: {
      async applyEdit(edit) {
        for (const operation of edit.operations) {
          pending.set(operation.uri.fsPath, operation.content);
          api.editorWrites.push({ path: operation.uri.fsPath, content: operation.content });
        }
        return true;
      },
      workspaceFolders: roots.map((fsPath) => ({
        name: path.basename(fsPath),
        uri: { fsPath },
      })),
      getConfiguration: () => ({
        get: (name, fallback) => {
          if (name === "allowFileWrites") return true;
          if (name === "reviewFileWrites") return reviewWrites;
          return fallback;
        },
      }),
      asRelativePath: (value) => path.basename(String(value)),
      registerTextDocumentContentProvider(_scheme, provider) {
        contentProvider = provider;
        return { dispose() {} };
      },
      async openTextDocument(uri) {
        if (uri.scheme === "file") {
          if (!fs.existsSync(uri.fsPath)) throw new Error("cannot open");
          const text = () => pending.get(uri.fsPath) ?? fs.readFileSync(uri.fsPath, "utf8");
          return {
            uri,
            getText: () => text(),
            positionAt: (offset) => ({ line: 0, character: offset }),
            get lineCount() {
              return text().split(/\r\n|\r|\n/).length;
            },
            async save() {
              // Saving is what puts the edited buffer on disk — and what runs
              // the save participants, format-on-save among them.
              if (pending.has(uri.fsPath)) {
                const text = pending.get(uri.fsPath);
                fs.writeFileSync(uri.fsPath, formatOnSave ? formatter(text) : text);
                pending.delete(uri.fsPath);
              }
              return true;
            },
          };
        }
        const lines = () =>
          contentProvider.provideTextDocumentContent(uri).split(/\r\n|\r|\n/);
        return {
          uri,
          get lineCount() {
            return Math.max(1, lines().length);
          },
          lineAt(line) {
            const text = lines()[line] ?? "";
            return { range: { end: { line, character: text.length } } };
          },
        };
      },
      onDidChangeTextDocument(listener) {
        changeDocumentListeners.add(listener);
        return { dispose: () => changeDocumentListeners.delete(listener) };
      },
      onDidCloseTextDocument(listener) {
        closeDocumentListeners.add(listener);
        return { dispose: () => closeDocumentListeners.delete(listener) };
      },
    },
    window: {
      visibleTextEditors: [],
      activeTextEditor: undefined,
      createTextEditorDecorationType() {
        return { dispose() {} };
      },
      async showTextDocument(document) {
        const editor = {
          document,
          selection: { active: { line: 0 } },
          setDecorations() {},
        };
        api.window.visibleTextEditors = [editor];
        api.window.activeTextEditor = editor;
        for (const listener of visibleListeners) listener([editor]);

        setImmediate(async () => {
          // Every action is a CodeLens. Inlay hints look more like buttons but
          // only fire through ClickLinkGesture, which needs the trigger
          // modifier held — a plain click does nothing, so they cannot be the
          // primary control.
          const hunkAction = (name) =>
            codeLensProvider
              .provideCodeLenses(document)
              .find((item) => item.command.command === name)?.command;

          if (reviewAction === "acceptBothWithoutWaiting") {
            // Two clicks in quick succession, as a person actually clicks:
            // the second lands before the first has finished writing.
            const lenses = codeLensProvider.provideCodeLenses(document);
            const accepts = lenses.filter(
              (item) => item.command.command === "kiroChat.review.acceptHunk"
            );
            await Promise.all(
              accepts.map((item) => commands.get(item.command.command)(...item.command.arguments))
            );
            return;
          }
          if (reviewAction === "acceptFirstThenClose") {
            const accept = hunkAction("kiroChat.review.acceptHunk");
            await commands.get(accept.command)(...accept.arguments);
            // Closing the tab with hunks still undecided.
            await api.commands.executeCommand("workbench.action.closeActiveEditor");
            return;
          }
          if (reviewAction === "acceptFirstRejectRest") {
            const accept = hunkAction("kiroChat.review.acceptHunk");
            await commands.get(accept.command)(...accept.arguments);
            const reviewedFile = path.join(roots[0], "example.js");
            if (fs.existsSync(reviewedFile)) {
              api.reviewSnapshots.push(fs.readFileSync(reviewedFile, "utf8"));
            }
            const reject = hunkAction("kiroChat.review.rejectHunk");
            await commands.get(reject.command)(...reject.arguments);
            return;
          }

          const lenses = codeLensProvider.provideCodeLenses(document);
          const wanted =
            reviewAction === "applyAll"
              ? "kiroChat.review.acceptAll"
              : "kiroChat.review.rejectAll";
          const lens = lenses.find((item) => item.command.command === wanted);
          await commands.get(wanted)(...lens.command.arguments);
        });
        return editor;
      },
      showErrorMessage() {},
      showInformationMessage() {},
      onDidChangeVisibleTextEditors(listener) {
        visibleListeners.add(listener);
        return { dispose: () => visibleListeners.delete(listener) };
      },
    },
    languages: {
      registerCodeLensProvider(_selector, provider) {
        codeLensProvider = provider;
        return { dispose() {} };
      },
    },
    commands: {
      registerCommand(name, handler) {
        commands.set(name, handler);
        return { dispose: () => commands.delete(name) };
      },
      async executeCommand(name, ...args) {
        if (name === "workbench.action.closeActiveEditor") {
          const closing = api.window.activeTextEditor?.document;
          api.window.visibleTextEditors = [];
          api.window.activeTextEditor = undefined;
          for (const listener of visibleListeners) listener([]);
          if (closing) {
            for (const listener of closeDocumentListeners) listener(closing);
          }
        }
      },
    },
    Uri,
    ViewColumn: { Active: 1 },
    EventEmitter,
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    OverviewRulerLane: { Right: 4 },
    Range: class {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    CodeLens: class {
      constructor(range, command) {
        this.range = range;
        this.command = command;
      }
    },
  };
  return api;
}

function loadSession(vscode) {
  const original = Module._load;
  Module._load = function (request, ...args) {
    if (request === "vscode") return vscode;
    return original.call(this, request, ...args);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}out${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(root, "out", "kiroSession.js")).KiroSession;
  } finally {
    Module._load = original;
  }
}

function events() {
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
  };
}

async function exercise(action, readOnly = false) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-review-"));
  const file = path.join(folder, "example.js");
  const before = "const value = 'old';\n";
  const after = "const value = 'new';\n";
  fs.writeFileSync(file, before);

  try {
    const vscode = fakeVscode(folder, action);
    const KiroSession = loadSession(vscode);
    const session = new KiroSession({ appendLine() {} }, events());
    session.turnReadOnly = readOnly;
    session.beginTurnFileCapture([
      { type: "resource_link", uri: pathToFileURL(file).href, name: "example.js" },
    ]);
    session.observeToolPaths({
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      title: "Editing example.js",
      kind: "edit",
      rawInput: {
        command: "strReplace",
        path: file,
        oldStr: before,
        newStr: after,
      },
    });

    // This is the direct disk write performed inside Kiro CLI 2.21.
    fs.writeFileSync(file, after);
    await session.finishDirectFileReviews();
    return fs.readFileSync(file, "utf8");
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
}

/**
 * The same turn as `exercise`, reporting which route the accepted content
 * took to disk: through a workspace edit (undoable) or straight to the file.
 */
async function exerciseWritePath(action, errors = [], formatOnSave = false) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-undo-"));
  const file = path.join(folder, "example.js");
  // Two separated edits, so a per-hunk decision has something to decide.
  const before = "const value = 'old';\nkeep\nconst other = 'old';\n";
  const after = "const value = 'new';\nkeep\nconst other = 'new';\n";
  fs.writeFileSync(file, before);

  try {
    const vscode = fakeVscode(folder, action, true, formatOnSave);
    const KiroSession = loadSession(vscode);
    const sessionEvents = events();
    sessionEvents.onError = (message) => errors.push(message);
    const session = new KiroSession({ appendLine() {} }, sessionEvents);
    session.beginTurnFileCapture([
      { type: "resource_link", uri: pathToFileURL(file).href, name: "example.js" },
    ]);
    session.observeToolPaths({
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      title: "Editing example.js",
      kind: "edit",
      rawInput: { command: "strReplace", path: file, oldStr: before, newStr: after },
    });

    fs.writeFileSync(file, after);
    // A review that refuses every decision never resolves, which would hang
    // the run rather than fail it. Time it out so the failure is readable.
    const stalled = Symbol("stalled");
    const outcome = await Promise.race([
      session.finishDirectFileReviews().then(() => "settled"),
      new Promise((resolve) => setTimeout(() => resolve(stalled), 3000).unref()),
    ]);
    if (outcome === stalled) errors.push("the review never settled");
    return {
      content: fs.readFileSync(file, "utf8"),
      editorWrites: vscode.editorWrites,
    };
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
}

/**
 * The same turn as `exercise`, but watching what the chat is told afterwards.
 * `reported` collects every keep-or-undo card the session offers.
 */
async function exerciseReporting(action, reported) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-report-"));
  const file = path.join(folder, "example.js");
  const before = "const value = 'old';\n";
  const after = "const value = 'new';\n";
  fs.writeFileSync(file, before);

  try {
    const reviews = action === "noReview";
    const vscode = fakeVscode(folder, reviews ? undefined : action, !reviews);
    const KiroSession = loadSession(vscode);
    const sessionEvents = events();
    sessionEvents.onTurnChanges = (summary) => reported.push(summary);
    const session = new KiroSession({ appendLine() {} }, sessionEvents);
    session.beginTurnFileCapture([
      { type: "resource_link", uri: pathToFileURL(file).href, name: "example.js" },
    ]);
    session.observeToolPaths({
      sessionUpdate: "tool_call",
      toolCallId: "write-1",
      title: "Editing example.js",
      kind: "edit",
      rawInput: { command: "strReplace", path: file, oldStr: before, newStr: after },
    });

    fs.writeFileSync(file, after);
    await session.finishDirectFileReviews();
    session.reportTurnChanges();
    return fs.readFileSync(file, "utf8");
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
}

test("a direct Kiro write is kept only after Apply all", async () => {
  assert.equal(await exercise("applyAll"), "const value = 'new';\n");
});

test("a direct Kiro write is restored when the review is rejected", async () => {
  assert.equal(await exercise("reject"), "const value = 'old';\n");
});

test("Plan mode restores a direct Kiro write without opening a review", async () => {
  assert.equal(await exercise("reject", true), "const value = 'old';\n");
});

test("every root in a multi-root workspace is inside the review boundary", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-multiroot-"));
  const backend = path.join(parent, "backend");
  const frontend = path.join(parent, "frontend");
  fs.mkdirSync(backend);
  fs.mkdirSync(frontend);

  try {
    const vscode = fakeVscode([backend, frontend], "reject");
    const KiroSession = loadSession(vscode);
    const session = new KiroSession({ appendLine() {} }, events());
    const frontendFile = path.join(frontend, "src", "Avatar.js");

    assert.equal(session.resolveInsideWorkspace(frontendFile), frontendFile);
    assert.throws(
      () => session.resolveInsideWorkspace(path.join(parent, "outside", "secret.txt")),
      /outside the open folders/
    );
  } finally {
    fs.rmdirSync(frontend);
    fs.rmdirSync(backend);
    fs.rmdirSync(parent);
  }
});

test("a Kiro permission request round-trips through the chat handler", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-permission-"));
  try {
    const vscode = fakeVscode(folder, "reject");
    const KiroSession = loadSession(vscode);
    const handlers = events();
    let shown;
    handlers.onPermission = async (request) => {
      shown = request;
      return "allow-once";
    };
    const session = new KiroSession({ appendLine() {} }, handlers);
    const result = await session.askPermission({
      toolCall: { title: "edit example.js" },
      options: [
        { optionId: "allow-once", name: "Yes", kind: "allow_once" },
        { optionId: "reject", name: "No", kind: "reject_once" },
      ],
    });

    assert.equal(shown.title, "edit example.js");
    assert.deepEqual(
      shown.options.map((option) => option.label),
      ["Yes", "No"]
    );
    assert.deepEqual(result, {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
  } finally {
    fs.rmdirSync(folder);
  }
});

test("nearby changed blocks still get separate accept and reject actions", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-hunks-"));
  try {
    const vscode = fakeVscode(folder, "acceptFirstRejectRest");
    const KiroSession = loadSession(vscode);
    const session = new KiroSession({ appendLine() {} }, events());
    const beforeLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const afterLines = [...beforeLines];
    afterLines[1] = "accepted change";
    // Only one unchanged line separates these edits. A conventional diff
    // merges them, but review controls must keep them independently selectable.
    afterLines[3] = "rejected change";
    const before = `${beforeLines.join("\n")}\n`;
    const after = `${afterLines.join("\n")}\n`;
    const file = path.join(folder, "example.js");
    fs.writeFileSync(file, before);
    const expected = [...beforeLines];
    expected[1] = "accepted change";

    const decision = await session.changeReviewer.review({
      path: "example.js",
      before,
      after,
      creating: false,
      applyContent: async (content, exists) => {
        if (exists) fs.writeFileSync(file, content);
        else if (fs.existsSync(file)) fs.unlinkSync(file);
      },
    });

    assert.equal(decision.accepted, true);
    assert.equal(decision.content, `${expected.join("\n")}\n`);
    assert.equal(
      vscode.reviewSnapshots[0],
      `${expected.join("\n")}\n`,
      "the first accepted hunk should be written before the remaining review finishes"
    );
  } finally {
    const file = path.join(folder, "example.js");
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
});


/**
 * Accepting a hunk writes it to disk immediately, and the editor shows it
 * land. Closing the tab afterwards used to call rejectAll, which rewrites the
 * pre-turn contents over the whole file — silently undoing work the user had
 * already accepted and watched happen. Closing may only drop what is still
 * undecided.
 */
test("closing the review keeps hunks that were already accepted", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-close-"));
  try {
    const vscode = fakeVscode(folder, "acceptFirstThenClose");
    const KiroSession = loadSession(vscode);
    const session = new KiroSession({ appendLine() {} }, events());

    const beforeLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const afterLines = [...beforeLines];
    afterLines[1] = "accepted change";
    afterLines[3] = "abandoned change";
    const before = `${beforeLines.join("\n")}\n`;
    const after = `${afterLines.join("\n")}\n`;
    const file = path.join(folder, "example.js");
    fs.writeFileSync(file, before);

    await session.changeReviewer.review({
      path: "example.js",
      before,
      after,
      creating: false,
      applyContent: async (content, exists) => {
        if (exists) fs.writeFileSync(file, content);
        else if (fs.existsSync(file)) fs.unlinkSync(file);
      },
    });

    const onDisk = fs.readFileSync(file, "utf8");
    assert.match(onDisk, /accepted change/, "the accepted hunk must survive the close");
    assert.doesNotMatch(
      onDisk,
      /abandoned change/,
      "the hunk that was never decided is still rejected"
    );
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/**
 * Accepting a hunk writes to disk asynchronously. A second click arriving
 * before that finished used to be dropped on the floor by an `applying` guard,
 * with nothing on screen to say so: the count stopped going down, the button
 * kept doing nothing, and the review could never complete.
 */
test("a second decision made before the first finishes is not lost", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-race-"));
  try {
    const vscode = fakeVscode(folder, "acceptBothWithoutWaiting");
    const KiroSession = loadSession(vscode);
    const session = new KiroSession({ appendLine() {} }, events());

    const beforeLines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const afterLines = [...beforeLines];
    afterLines[1] = "first change";
    afterLines[3] = "second change";
    const before = `${beforeLines.join("\n")}\n`;
    const after = `${afterLines.join("\n")}\n`;
    const file = path.join(folder, "example.js");
    fs.writeFileSync(file, before);

    // A dropped decision means the review never settles, so this would hang
    // rather than fail. Time it out and report it as the stall it is.
    const decision = await Promise.race([
      session.changeReviewer.review({
        path: "example.js",
        before,
        after,
        creating: false,
        applyContent: async (content, exists) => {
          // A real write takes a tick; that gap is where clicks were lost.
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (exists) fs.writeFileSync(file, content);
          else if (fs.existsSync(file)) fs.unlinkSync(file);
        },
      }),
      new Promise((resolve) => setTimeout(() => resolve({ stalled: true }), 3000)),
    ]);
    assert.ok(!decision.stalled, "the review never settled: a decision was dropped");

    assert.equal(decision.accepted, true, "both accepts should settle the review");
    const onDisk = fs.readFileSync(file, "utf8");
    assert.match(onDisk, /first change/, "the first accepted hunk must land");
    assert.match(onDisk, /second change/, "and so must the one clicked right after it");
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/*
 * One question, not two.
 *
 * Every hunk was answered in the diff. Asking "keep all changes or undo?"
 * afterwards is the same question a second time, and the user has already
 * given a more precise answer than the card can take.
 */
test("a file answered in the diff is not asked about again", async () => {
  const reported = [];
  await exerciseReporting("applyAll", reported);
  assert.deepEqual(reported, [], "the reviewed file must not produce a turn-changes card");
});

/** A change nobody reviewed still needs the card, because nothing else asked. */
test("a change that never opened a review is still reported", async () => {
  const reported = [];
  await exerciseReporting("noReview", reported);
  assert.equal(reported.length, 1, "an unreviewed change is the card's whole purpose");
  assert.match(reported[0].text, /example\.js/);
});

/*
 * Ctrl+Z has to work on a change you accepted.
 *
 * A raw fs.writeFile is invisible to the editor: the document reloads with no
 * undo entry, so the change is permanent and the only way back is the chat's
 * own undo. Anything the user can accept, they must be able to undo the
 * ordinary way, in the file, where they are already looking.
 */
test("an accepted change is written through the editor so Ctrl+Z can undo it", async () => {
  const { content, editorWrites } = await exerciseWritePath("applyAll");
  assert.equal(
    content,
    "const value = 'new';\nkeep\nconst other = 'new';\n",
    "the change still has to land"
  );
  assert.ok(
    editorWrites.some((write) => write.path.endsWith("example.js")),
    "the accepted content must go through a workspace edit, not straight to disk"
  );
});

/** Accepting one hunk writes immediately; that write needs undo too. */
test("a hunk accepted on its own is also written through the editor", async () => {
  const { editorWrites } = await exerciseWritePath("acceptFirstRejectRest");
  assert.ok(
    editorWrites.some((write) => write.path.endsWith("example.js")),
    "per-hunk writes must be undoable as well"
  );
});

/*
 * Only the accepted content goes through the editor.
 *
 * Putting a file back is not an edit the user made and has to be exact, so it
 * stays a plain disk write. If it went through the editor it would be saved,
 * and saving runs format-on-save — rejecting a change could then leave the
 * file reformatted instead of as it was.
 */
test("restoring the original does not go through the editor", async () => {
  const { editorWrites } = await exerciseWritePath("applyAll");
  const restores = editorWrites.filter((write) =>
    write.content.includes("const value = 'old';")
  );
  assert.deepEqual(restores, [], "a restore must not be saved through the editor");
});

/*
 * Format-on-save runs when the accepted content is saved.
 *
 * Writing through the editor means save participants get a turn, so what
 * lands on disk is not byte for byte what was accepted. That is the same
 * thing that happens when the user edits and saves the file themselves, and
 * it must not be mistaken for somebody else editing the file mid-review.
 */
test("format-on-save after an accepted change is not treated as interference", async () => {
  const errors = [];
  const { content } = await exerciseWritePath("applyAll", errors, true);

  assert.deepEqual(errors, [], "a formatter is not an outside edit");
  assert.match(content, /"new"/, "the accepted change survives, formatted");
});

/** The same for a per-hunk accept, where a second hunk follows the first. */
test("a formatter between two hunk decisions does not abort the review", async () => {
  const errors = [];
  await exerciseWritePath("acceptFirstRejectRest", errors, true);
  assert.deepEqual(errors, [], "the second decision must still be applicable");
});

// ---------------------------------------------------------------------------
// The gap the write heuristic used to leave open.
//
// `isWriteLikeTool` gated the *snapshot*, not only the simulation — so a tool
// shape it did not recognise, or a path it could not find, meant no baseline,
// no review, no keep-or-undo card, and Kiro's edit simply appeared on disk.
// Both shapes below are real: the payload captured in test/toolSteps.test.js
// carries its path in `locations` and in `rawInput.operations[].path`, and in
// neither of the two places the old extractor looked.
// ---------------------------------------------------------------------------

/**
 * Drive one turn with an arbitrary tool update and a direct write behind it.
 * `attach` decides whether the file is also a prompt attachment, which is the
 * other way a baseline can be taken.
 */
async function exerciseTool({ update, action = "reject", attach = false, write = true }) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-gap-"));
  const file = path.join(folder, "example.js");
  const before = "const value = 'old';\n";
  const after = "const value = 'new';\n";
  fs.writeFileSync(file, before);

  try {
    const vscode = fakeVscode(folder, action);
    const KiroSession = loadSession(vscode);
    const reported = [];
    const handlers = events();
    handlers.onTurnChanges = (summary) => reported.push(summary);
    const session = new KiroSession({ appendLine() {} }, handlers);

    session.beginTurnFileCapture(
      attach
        ? [{ type: "resource_link", uri: pathToFileURL(file).href, name: "example.js" }]
        : []
    );
    if (update) session.observeToolPaths(update(file));

    // Kiro CLI performing the write itself, inside its own tool.
    if (write) fs.writeFileSync(file, after);
    await session.finishDirectFileReviews();
    // The keep-or-undo card, which a real turn posts straight afterwards.
    session.reportTurnChanges();
    return { content: fs.readFileSync(file, "utf8"), before, after, reported };
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    fs.rmdirSync(folder);
  }
}

/** Not an edit by any measure the heuristic has: unknown kind, no command. */
const unrecognisedWrite = (file) => ({
  sessionUpdate: "tool_call",
  toolCallId: "mystery-1",
  title: "Applying a patch to example.js",
  kind: "custom_patch",
  locations: [{ path: file }],
});

test("a write tool nobody recognises is still reviewed", async () => {
  const result = await exerciseTool({ update: unrecognisedWrite, action: "reject" });

  assert.equal(
    result.content,
    result.before,
    "an unrecognised write must still open a review, and rejecting it must restore the file"
  );
});

test("an unrecognised write that is accepted is kept", async () => {
  const result = await exerciseTool({ update: unrecognisedWrite, action: "applyAll" });
  assert.equal(result.content, result.after, "accepting it must keep Kiro's edit");
});

/** The operations[] form, which the old path extractor never looked at. */
test("a write whose path is only in rawInput.operations is found", async () => {
  const result = await exerciseTool({
    update: (file) => ({
      sessionUpdate: "tool_call",
      toolCallId: "ops-1",
      title: "Editing example.js",
      kind: "edit",
      rawInput: { command: "strReplace", operations: [{ mode: "Line", path: file }] },
    }),
    action: "reject",
  });

  assert.equal(result.content, result.before, "the path in operations[] has to be found");
});

/**
 * A read earns a snapshot but not a diff.
 *
 * 0.25.0 reviewed anything snapshotted that differed by the end of the turn,
 * which swept in files Kiro had only read — so a watcher, a formatter or a dev
 * server rewriting one mid-turn opened a diff, and rejecting it would have
 * clobbered a write Kiro never made. The change still has to be *reported*
 * though; going quiet about it would be the original bug again.
 */
test("a file only ever read is reported, not opened as a diff", async () => {
  const result = await exerciseTool({
    update: (file) => ({
      sessionUpdate: "tool_call",
      toolCallId: "read-1",
      title: "Reading example.js:1",
      kind: "read",
      locations: [{ path: file }],
    }),
    // Would restore the file if a review had opened for it.
    action: "reject",
  });

  assert.equal(
    result.content,
    result.after,
    "a file Kiro only read must not be restored over by a review it never earned"
  );
  assert.equal(result.reported.length, 1, "but the change still has to be reported");
  assert.equal(result.reported[0].files.length, 1);
  assert.match(result.reported[0].files[0].path, /example\.js$/);
});

/** An unknown tool is assumed to have written, which is what keeps 0.25.0's fix. */
test("an unrecognised tool still earns a review, unlike a read", async () => {
  const result = await exerciseTool({
    update: (file) => ({
      sessionUpdate: "tool_call",
      toolCallId: "mystery-3",
      title: "Doing something to example.js",
      kind: "something_new",
      locations: [{ path: file }],
    }),
    action: "reject",
  });

  assert.equal(
    result.content,
    result.before,
    "only a kind that positively cannot write may opt out of review"
  );
});

/**
 * The deliberate exclusion. A file gets a baseline for one of two reasons: a
 * tool mentioned it, or the user attached it. Only the first means Kiro was
 * working on it. Reviewing the second would hand the user a diff offering to
 * undo an edit they made themselves while the turn was running.
 */
test("a file the user edited, that no tool touched, is not reviewed", async () => {
  const result = await exerciseTool({ update: undefined, attach: true, action: "reject" });

  assert.equal(
    result.content,
    result.after,
    "an attachment nothing touched must be left alone, not restored over"
  );
});

/** Nothing changed means nothing to answer for; no diff should open. */
test("a turn that changes nothing opens no review", async () => {
  const result = await exerciseTool({
    update: (file) => ({
      sessionUpdate: "tool_call",
      toolCallId: "read-2",
      title: "Reading example.js:1",
      kind: "read",
      locations: [{ path: file }],
    }),
    write: false,
    action: "reject",
  });

  assert.equal(result.content, result.before, "an untouched file stays exactly as it was");
});
