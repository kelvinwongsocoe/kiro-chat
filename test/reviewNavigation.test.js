// Jumping between the pending changes in an open review.
//
// A file with several proposed edits is unreadable if the only way to reach
// the next one is to scroll and hunt for a coloured line. These drive the real
// ChangeReviewer through a fake editor and assert where the cursor lands.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");
const reviewerSource = fs.readFileSync(path.join(root, "src", "changeReviewer.ts"), "utf8");
const providerSource = fs.readFileSync(path.join(root, "src", "chatViewProvider.ts"), "utf8");
const sessionSource = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
const chatJs = fs.readFileSync(path.join(root, "media", "chat.js"), "utf8");
const css = fs.readFileSync(path.join(root, "media", "chat.css"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function fakeVscode() {
  const commands = new Map();
  const visibleListeners = new Set();
  const closeListeners = new Set();
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

  class Uri {
    constructor(scheme, uriPath) {
      this.scheme = scheme;
      this.path = uriPath;
      this.fsPath = uriPath;
    }
    toString() {
      return `${this.scheme}:${this.path}`;
    }
    static from(parts) {
      return new Uri(parts.scheme, parts.path);
    }
    static file(fsPath) {
      return new Uri("file", String(fsPath).replace(/\\/g, "/"));
    }
  }

  const api = {
    revealed: [],
    languageChanges: [],
    workspace: {
      registerTextDocumentContentProvider(_scheme, provider) {
        contentProvider = provider;
        return { dispose() {} };
      },
      async openTextDocument(uri) {
        // The real file, opened only to read the language off it. A name
        // ending in "(Working Tree)" matches no language, which is why the
        // review document below comes back as plain text.
        if (uri.scheme === "file") return { uri, languageId: "javascript" };
        const lines = () =>
          contentProvider.provideTextDocumentContent(uri).split(/\r\n|\r|\n/);
        return {
          uri,
          languageId: "plaintext",
          get lineCount() {
            return Math.max(1, lines().length);
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
        const existing = api.window.visibleTextEditors.find(
          (editor) => editor.document.uri.toString() === document.uri.toString()
        );
        if (existing) {
          api.window.activeTextEditor = existing;
          return existing;
        }
        const editor = {
          document,
          selection: { active: { line: 0 } },
          setDecorations() {},
          revealRange(range) {
            api.revealed.push(range.start.line);
          },
        };
        api.window.visibleTextEditors = [editor];
        api.window.activeTextEditor = editor;
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
        api.languageChanges.push(languageId);
        // VS Code recreates the document, which fires a close for the old one.
        // A review that treated that as the user closing the tab would reject
        // itself the instant it opened.
        for (const listener of closeListeners) listener(document);
        return { ...document, languageId };
      },
    },
    commands: {
      registerCommand(name, handler) {
        commands.set(name, handler);
        return { dispose: () => commands.delete(name) };
      },
      async executeCommand() {},
      run: (name, ...args) => commands.get(name)(...args),
      has: (name) => commands.has(name),
    },
    Uri,
    EventEmitter,
    ThemeColor: class {
      constructor(id) {
        this.id = id;
      }
    },
    OverviewRulerLane: { Right: 4 },
    TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
    Range: class {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
      }
    },
    Selection: class {
      constructor(startLine, startCharacter, endLine, endCharacter) {
        this.start = { line: startLine, character: startCharacter };
        this.end = { line: endLine, character: endCharacter };
        this.active = { line: endLine, character: endCharacter };
        this.anchor = { line: startLine, character: startCharacter };
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

function loadReviewer(vscode) {
  const original = Module._load;
  Module._load = function (request, ...args) {
    if (request === "vscode") return vscode;
    return original.call(this, request, ...args);
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

/** Three separated edits, so there is somewhere to jump to. */
const BEFORE = ["one", "keep", "two", "keep", "three", "keep"].join("\n") + "\n";
const AFTER = ["ONE", "keep", "TWO", "keep", "THREE", "keep"].join("\n") + "\n";

async function openReview() {
  const vscode = fakeVscode();
  const ChangeReviewer = loadReviewer(vscode);
  const reviewer = new ChangeReviewer({ appendLine() {} });
  const settled = reviewer.review({
    path: "example.txt",
    sourcePath: "C:/work/example.txt",
    before: BEFORE,
    after: AFTER,
    creating: false,
    async applyContent() {},
  });
  // Let open() reach showTextDocument before anything navigates.
  await new Promise((resolve) => setImmediate(resolve));
  return { vscode, reviewer, settled };
}

const cursor = (vscode) => vscode.window.activeTextEditor.selection.active.line;

/*
 * The review tab must not look like the file itself.
 *
 * It is a third thing — both sides of the pending change merged together —
 * and a tab labelled exactly like the real file invites editing the wrong one.
 * Git names its diff of the same file `chat.js (Working Tree)`; this follows
 * that, because it is the convention the editor already teaches.
 */
test("the review tab is named the way git names a working-tree diff", async () => {
  const { vscode, reviewer, settled } = await openReview();
  const name = vscode.window.activeTextEditor.document.uri.path.split("/").pop();

  assert.equal(name, "example.txt (Working Tree)");

  await reviewer.rejectActive();
  await settled;
});

/*
 * A name that does not end in the extension is no longer enough for VS Code to
 * pick a language, so the review would render as plain text — colour is half
 * of what makes a diff readable. The language is taken from the real file and
 * set explicitly instead.
 */
test("the review keeps the syntax highlighting of the file it came from", async () => {
  const { vscode, reviewer, settled } = await openReview();

  // Changing the language recreates the document, firing the same close event
  // the user closing the tab fires. The review must not take that as an answer.
  let answered = false;
  settled.then(() => {
    answered = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(answered, false, "the language switch must not settle the review");

  assert.deepEqual(
    vscode.languageChanges,
    ["javascript"],
    "the review document must be given the real file's language"
  );

  await reviewer.rejectActive();
  await settled;
});

test("Next change walks the pending hunks in order and wraps", async () => {
  const { vscode, reviewer, settled } = await openReview();

  const first = cursor(vscode);
  await reviewer.gotoNext();
  const second = cursor(vscode);
  await reviewer.gotoNext();
  const third = cursor(vscode);

  assert.ok(second > first, `expected to move forward from ${first}, landed on ${second}`);
  assert.ok(third > second, `expected to move forward from ${second}, landed on ${third}`);

  // A fourth jump has nowhere further to go, so it comes back to the top.
  await reviewer.gotoNext();
  assert.equal(cursor(vscode), first, "the jump must wrap round to the first change");

  await reviewer.rejectActive();
  await settled;
});

test("Previous change walks back the other way", async () => {
  const { vscode, reviewer, settled } = await openReview();

  await reviewer.gotoNext();
  await reviewer.gotoNext();
  const third = cursor(vscode);
  await reviewer.gotoPrevious();
  const back = cursor(vscode);

  assert.ok(back < third, `expected to move back from ${third}, landed on ${back}`);

  await reviewer.rejectActive();
  await settled;
});

test("jumping scrolls the change into view rather than only moving the cursor", async () => {
  const { vscode, reviewer, settled } = await openReview();
  await reviewer.gotoNext();
  assert.ok(vscode.revealed.length > 0, "the reviewer must reveal the range it jumped to");
  await reviewer.rejectActive();
  await settled;
});

test("jumping does nothing once the review has settled", async () => {
  const { vscode, reviewer, settled } = await openReview();
  await reviewer.gotoNext();
  const landed = cursor(vscode);
  await reviewer.acceptActive();
  await settled;

  vscode.revealed.length = 0;
  await reviewer.gotoNext();
  assert.equal(cursor(vscode), landed, "a settled review must not move the cursor");
  assert.equal(vscode.revealed.length, 0, "and must not scroll a closed review into view");
});

test("the jump is reachable by command and by keyboard", async () => {
  const { vscode, reviewer, settled } = await openReview();

  assert.ok(vscode.commands.has("kiroChat.review.nextChange"));
  assert.ok(vscode.commands.has("kiroChat.review.previousChange"));

  const bound = manifest.contributes.keybindings.map((entry) => entry.command);
  assert.ok(bound.includes("kiroChat.review.nextChange"), "next needs a keybinding");
  assert.ok(bound.includes("kiroChat.review.previousChange"), "previous needs a keybinding");
  for (const entry of manifest.contributes.keybindings) {
    if (!entry.command.startsWith("kiroChat.review.")) continue;
    assert.match(
      entry.when,
      /kiroChat\.hunkReviewActive/,
      `${entry.command} must only bind while a review is open`
    );
  }

  // The command must actually reach the reviewer, not just exist.
  await vscode.commands.run("kiroChat.review.nextChange");
  assert.ok(cursor(vscode) > 0, "the command must move the cursor to a change");

  await reviewer.rejectActive();
  await settled;
});

/*
 * The diff can be behind the chat, so the bar has to offer the jump too —
 * as the summary line itself, the way a merge conflict is walked, rather than
 * a third button competing with the two decisions.
 */
test("the change bar offers the jump while a review is open", () => {
  assert.match(chatJs, /type: "gotoChange"/, "the bar must ask for the next change");
  assert.match(
    chatJs,
    /createElement\(review \? "button" : "div"\)/,
    "the summary is the control while a review is open"
  );
  assert.doesNotMatch(chatJs, /"Next change"/, "and there is no separate button for it");
  assert.match(
    css,
    /^button\.change-summary \{/m,
    "a summary that is a button must opt out of the global button styling"
  );
  assert.match(providerSource, /case "gotoChange"/, "the provider must handle it");
  assert.match(sessionSource, /gotoNextChange/, "the session must pass it on");
  assert.match(reviewerSource, /async gotoNext\(\)/);
  assert.match(reviewerSource, /async gotoPrevious\(\)/);
});
