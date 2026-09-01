// Activation has to survive one registration failing.
//
// Everything used to be registered as arguments to a single
// context.subscriptions.push(...) call. Arguments are all evaluated before the
// call runs, so one throwing registration meant every command after it in the
// list was never registered — the panel still appeared, but New Session,
// Restart, Show History and the keybinding were all silently dead.
//
// Adding a view is a manifest change and VS Code only picks those up on a full
// restart, so createTreeView throwing "No view is registered" is an ordinary
// thing to happen after an upgrade, not an exceptional one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..");

/** Enough of the vscode API for activate() to run. */
function fakeVscode(options = {}) {
  const registered = { commands: [], views: [], trees: [], participants: [] };
  const noop = () => ({ dispose() {} });
  const api = {
    __registered: registered,
    window: {
      createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose() {} }),
      showErrorMessage: () => Promise.resolve(undefined),
      showInformationMessage: () => Promise.resolve(undefined),
      showWarningMessage: () => Promise.resolve(undefined),
      registerWebviewViewProvider: (id) => {
        registered.views.push(id);
        return { dispose() {} };
      },
      createTreeView: (id) => {
        if (options.treeViewThrows) throw new Error(`No view is registered with id: ${id}`);
        registered.trees.push(id);
        return { dispose() {} };
      },
      onDidChangeTextEditorSelection: noop,
      onDidChangeActiveTextEditor: noop,
      activeTextEditor: undefined,
    },
    chat: {
      createChatParticipant: (id) => {
        if (options.participantThrows) throw new Error(`no chat participant: ${id}`);
        registered.participants.push(id);
        return { dispose() {}, set iconPath(v) {} };
      },
    },
    commands: {
      registerCommand: (id) => {
        registered.commands.push(id);
        return { dispose() {} };
      },
      executeCommand: () => Promise.resolve(undefined),
    },
    workspace: {
      workspaceFolders: undefined,
      getConfiguration: () => ({ get: (_k, d) => d, update: () => Promise.resolve(), inspect: () => undefined }),
      onDidChangeConfiguration: noop,
      asRelativePath: (p) => String(p),
    },
    Uri: { joinPath: (...parts) => ({ fsPath: parts.join("/") }), file: (p) => ({ fsPath: p }) },
    ThemeIcon: class { constructor(id) { this.id = id; } },
    TreeItem: class { constructor(label) { this.label = label; } },
    ConfigurationTarget: { Global: 1 },
    FileType: { Directory: 2 },
    env: { clipboard: { writeText: () => Promise.resolve() } },
  };
  return api;
}

/** Load out/extension.js with `vscode` stubbed out. */
function activateWith(api) {
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "vscode") return api;
    return original.call(this, request, ...rest);
  };
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}out${path.sep}`)) delete require.cache[key];
    }
    const { activate } = require(path.join(root, "out", "extension.js"));
    const context = {
      subscriptions: [],
      extensionUri: { fsPath: root },
      globalState: { get: (_k, d) => d, update: () => Promise.resolve() },
      extension: { packageJSON: { version: "0.0.0-test" } },
    };
    activate(context);
    return context;
  } finally {
    Module._load = original;
  }
}

const contributed = () =>
  JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).contributes.commands.map(
    (c) => c.command
  );

test("every contributed command is registered when all is well", () => {
  const api = fakeVscode();
  activateWith(api);
  for (const command of contributed()) {
    assert.ok(
      api.__registered.commands.includes(command),
      `${command} was never registered`
    );
  }
  assert.deepEqual(api.__registered.participants, ["kiroChat.participant"]);
});

/** The participant is a manifest contribution too, and can be rejected. */
test("a chat participant that will not register takes nothing else down", () => {
  const api = fakeVscode({ participantThrows: true });
  activateWith(api);

  for (const command of contributed()) {
    assert.ok(
      api.__registered.commands.includes(command),
      `${command} was lost because the participant failed`
    );
  }
  assert.ok(api.__registered.views.includes("kiroChat.view"), "the panel must survive");
});

/** Both failing at once must still leave a working extension. */
test("everything optional failing still leaves the panel and commands", () => {
  const api = fakeVscode({ participantThrows: true, treeViewThrows: true });
  activateWith(api);
  for (const command of contributed()) {
    assert.ok(api.__registered.commands.includes(command), `${command} was lost`);
  }
  assert.ok(api.__registered.views.includes("kiroChat.view"));
});
