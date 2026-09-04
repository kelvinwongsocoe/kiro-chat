// What happens to the review's tab when the review settles.
//
// `finish` used to close the editor only when the review was the *active* one.
// Accepting from the chat bar while looking at another file therefore took the
// other branch: the tab stayed open and its backing content was deleted out
// from under it, leaving a stale "(Working Tree)" tab with nothing behind it.
// The chat bar exists precisely so the diff does not have to be in front of
// you, so this was the ordinary path, not an edge case.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");

function fakeVscode({ withTabGroups = true, reviewLanguage = "javascript" } = {}) {
  const closeListeners = new Set();
  const visibleListeners = new Set();
  const commands = new Map();
  let contentProvider;

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

  const tabs = [];
  const api = {
    closedTabs: [],
    ranCommands: [],
    /** What the content provider would still serve for a review document. */
    contentFor: (uri) => contentProvider.provideTextDocumentContent(uri),
    EventEmitter,
    ThemeColor: class {},
    OverviewRulerLane: { Right: 4 },
    Range: class {
      constructor(sl, sc, el, ec) {
        this.start = { line: sl, character: sc };
        this.end = { line: el, character: ec };
      }
    },
    Selection: class {
      constructor(sl, sc, el, ec) {
        this.active = { line: sl, character: sc };
        this.start = { line: sl, character: sc };
        this.end = { line: el, character: ec };
      }
    },
    CodeLens: class {
      constructor(range, command) {
        this.range = range;
        this.command = command;
      }
    },
    Uri: {
      from: (parts) => ({
        ...parts,
        toString: () => `${parts.scheme}:${parts.path}`,
      }),
      file: (fsPath) => ({
        scheme: "file",
        path: String(fsPath).replace(/\\/g, "/"),
        fsPath,
        toString: () => `file:${String(fsPath).replace(/\\/g, "/")}`,
      }),
    },
    workspace: {
      registerTextDocumentContentProvider(_scheme, provider) {
        contentProvider = provider;
        return { dispose() {} };
      },
      async openTextDocument(uri) {
        if (uri.scheme === "file") return { uri, languageId: "javascript" };
        return {
          uri,
          languageId: reviewLanguage,
          get lineCount() {
            return Math.max(1, contentProvider.provideTextDocumentContent(uri).split("\n").length);
          },
        };
      },
      onDidChangeTextDocument() {
        return { dispose() {} };
      },
      onDidCloseTextDocument(listener) {
        closeListeners.add(listener);
        return { dispose: () => closeListeners.delete(listener) };
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
          revealRange() {},
        };
        api.window.visibleTextEditors = [editor];
        api.window.activeTextEditor = editor;
        tabs.push({ input: { uri: document.uri } });
        for (const listener of visibleListeners) listener([editor]);
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
      registerCodeLensProvider() {
        return { dispose() {} };
      },
      async setTextDocumentLanguage(document, languageId) {
        for (const listener of closeListeners) listener(document);
        return { ...document, languageId };
      },
    },
    commands: {
      registerCommand(name, handler) {
        commands.set(name, handler);
        return { dispose: () => commands.delete(name) };
      },
      async executeCommand(name, ...args) {
        api.ranCommands.push(name);
        if (name === "workbench.action.closeActiveEditor") {
          const closing = api.window.activeTextEditor?.document;
          if (closing) {
            api.window.visibleTextEditors = [];
            api.window.activeTextEditor = undefined;
            for (const listener of closeListeners) listener(closing);
          }
        }
        const handler = commands.get(name);
        return handler ? handler(...args) : undefined;
      },
    },
    /** Simulate the user clicking away to some other file. */
    switchAwayTo(name) {
      const document = { uri: api.Uri.file(`C:/work/${name}`), languageId: "javascript" };
      const editor = { document, selection: { active: { line: 0 } }, setDecorations() {}, revealRange() {} };
      api.window.activeTextEditor = editor;
      api.window.visibleTextEditors = [editor];
      tabs.push({ input: { uri: document.uri } });
    },
    openTabs: () => tabs.map((tab) => String(tab.input.uri)),
  };

  if (withTabGroups) {
    api.window.tabGroups = {
      get all() {
        return [{ tabs: [...tabs] }];
      },
      async close(target) {
        const list = Array.isArray(target) ? target : [target];
        for (const tab of list) {
          const index = tabs.indexOf(tab);
          if (index >= 0) tabs.splice(index, 1);
          api.closedTabs.push(String(tab.input.uri));
        }
        return true;
      },
    };
  }
  return api;
}

function loadReviewer(vscode) {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return vscode;
    return original.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}out${path.sep}`)) delete require.cache[key];
    }
    return require(path.join(root, "out", "changeReviewer.js")).ChangeReviewer;
  } finally {
    Module._load = original;
  }
}

/** Open a review, then leave the diff for another file, then accept from the bar. */
async function acceptFromTheBarWhileElsewhere(vscode) {
  const ChangeReviewer = loadReviewer(vscode);
  const reviewer = new ChangeReviewer({ appendLine() {} });

  const settled = reviewer.review({
    path: "example.js",
    sourcePath: "C:/work/example.js",
    before: "const value = 'old';\n",
    after: "const value = 'new';\n",
    creating: false,
    applyContent: async () => {},
  });

  // Let open() finish before anything acts on the review.
  await new Promise((resolve) => setImmediate(resolve));
  const reviewUri = vscode.openTabs().find((uri) => uri.startsWith("kiro-change-review:"));
  assert.ok(reviewUri, "the review should have opened a tab");

  // The diff is usually behind the chat; this is the normal way it is used.
  vscode.switchAwayTo("something-else.js");

  await reviewer.acceptActive();
  await settled;
  return { reviewer, reviewUri };
}

test("the review tab is closed even when the user is looking elsewhere", async () => {
  const vscode = fakeVscode();
  const { reviewUri } = await acceptFromTheBarWhileElsewhere(vscode);

  assert.ok(
    vscode.closedTabs.includes(reviewUri),
    "the settled review's tab should have been closed wherever it was"
  );
  assert.ok(
    !vscode.openTabs().includes(reviewUri),
    "no stale (Working Tree) tab should be left behind"
  );
});

/** Closing a tab that is not focused must not steal the user's current one. */
test("closing the review does not close the file the user moved to", async () => {
  const vscode = fakeVscode();
  await acceptFromTheBarWhileElsewhere(vscode);

  assert.ok(
    vscode.openTabs().some((uri) => uri.endsWith("something-else.js")),
    "the file the user switched to must still be open"
  );
  assert.ok(
    !vscode.ranCommands.includes("workbench.action.closeActiveEditor"),
    "closeActiveEditor would have closed the wrong tab"
  );
});

/**
 * Without tabGroups there is nothing that can close an unfocused tab. The old
 * code deleted the content anyway, so the leftover tab went blank; keeping it
 * means a tab that still shows what was reviewed.
 */
test("with no way to close it, the leftover tab keeps its content", async () => {
  const vscode = fakeVscode({ withTabGroups: false });
  const { reviewUri } = await acceptFromTheBarWhileElsewhere(vscode);

  const uri = { toString: () => reviewUri };
  assert.notEqual(
    vscode.contentFor(uri),
    "",
    "a tab that could not be closed must not be left showing an empty document"
  );
});

/** The focused case still works the way it always did. */
test("a focused review still closes through the active editor", async () => {
  const vscode = fakeVscode({ withTabGroups: false });
  const ChangeReviewer = loadReviewer(vscode);
  const reviewer = new ChangeReviewer({ appendLine() {} });

  const settled = reviewer.review({
    path: "example.js",
    sourcePath: "C:/work/example.js",
    before: "const value = 'old';\n",
    after: "const value = 'new';\n",
    creating: false,
    applyContent: async () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  await reviewer.acceptActive();
  await settled;

  assert.ok(
    vscode.ranCommands.includes("workbench.action.closeActiveEditor"),
    "the active-editor command remains the fallback"
  );
});

/*
 * The review must survive its own language being set.
 *
 * `applyLanguage` calls setTextDocumentLanguage, which recreates the document
 * and fires onDidCloseTextDocument for the old one — the same event the user
 * closing the tab fires, and it arrives *before* `active` is assigned. Anything
 * in that handler which reasons about "not the active review" therefore matches
 * the review that is opening. Cleaning up leftover documents that way emptied
 * the diff the moment it appeared.
 *
 * The default fake returns the same language for both documents, so the call is
 * skipped and this path is invisible; `reviewLanguage` forces it.
 */
test("a review keeps its content through the language being set", async () => {
  const vscode = fakeVscode({ reviewLanguage: "plaintext" });
  const ChangeReviewer = loadReviewer(vscode);
  const reviewer = new ChangeReviewer({ appendLine() {} });

  const settled = reviewer.review({
    path: "example.js",
    sourcePath: "C:/work/example.js",
    before: "const value = 'old';\n",
    after: "const value = 'new';\n",
    creating: false,
    applyContent: async () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));

  const reviewUri = vscode.openTabs().find((uri) => uri.startsWith("kiro-change-review:"));
  const content = vscode.contentFor({ toString: () => reviewUri });

  assert.notEqual(content, "", "the open review must not be rendered as an empty document");
  assert.match(content, /const value = 'old';/, "the original side should be there");
  assert.match(content, /const value = 'new';/, "and the proposed side too");

  await reviewer.acceptActive();
  await settled;
});
