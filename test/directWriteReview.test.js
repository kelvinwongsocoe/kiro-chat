const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { pathToFileURL, fileURLToPath } = require("node:url");

const root = path.join(__dirname, "..");

function fakeVscode(workspaceRoot, reviewAction) {
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
  }

  const api = {
    reviewSnapshots: [],
    workspace: {
      workspaceFolders: roots.map((fsPath) => ({
        name: path.basename(fsPath),
        uri: { fsPath },
      })),
      getConfiguration: () => ({
        get: (name, fallback) =>
          name === "allowFileWrites" || name === "reviewFileWrites" ? true : fallback,
      }),
      registerTextDocumentContentProvider(_scheme, provider) {
        contentProvider = provider;
        return { dispose() {} };
      },
      async openTextDocument(uri) {
        return {
          uri,
          get lineCount() {
            const content = contentProvider.provideTextDocumentContent(uri);
            return Math.max(1, content.split(/\r\n|\r|\n/).length);
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
          let lenses = codeLensProvider.provideCodeLenses(document);
          if (reviewAction === "acceptFirstRejectRest") {
            const accept = lenses.find(
              (item) => item.command.command === "kiroChat.review.acceptHunk"
            );
            await commands.get(accept.command.command)(...accept.command.arguments);
            const reviewedFile = path.join(roots[0], "example.js");
            if (fs.existsSync(reviewedFile)) {
              api.reviewSnapshots.push(fs.readFileSync(reviewedFile, "utf8"));
            }
            lenses = codeLensProvider.provideCodeLenses(document);
            const reject = lenses.find(
              (item) => item.command.command === "kiroChat.review.rejectHunk"
            );
            await commands.get(reject.command.command)(...reject.command.arguments);
            return;
          }
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
    session.observeDirectFileWrite({
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
