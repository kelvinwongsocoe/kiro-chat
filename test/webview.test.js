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

test("the composer offers and persists all requested workflow modes", () => {
  for (const label of ["Default", "Spec", "Quick Spec", "Bug Fix", "Plan"]) {
    assert.match(js, new RegExp(`label: "${label}"`));
  }
  assert.match(provider, /id="mode-btn"/);
  assert.match(provider, /id="mode-menu"/);
  assert.match(js, /mode: currentModeId/, "the selected mode must go with each request");
  assert.match(js, /mode: currentModeId[\s\S]*vscode\.setState|vscode\.setState\([\s\S]*mode: currentModeId/);
  assert.match(js, /setMode\(currentModeId, false\)/, "restoring a mode must not erase history");
  assert.match(css, /^\.mode-row \{/m);
});

test("tool permission choices are shown inside the chat instead of a modal", () => {
  const session = fs.readFileSync(path.join(root, "src", "kiroSession.ts"), "utf8");
  const permission = session.slice(session.indexOf("private async askPermission"));
  assert.match(provider, /onPermission:/, "the provider must own permission interaction");
  assert.match(provider, /permissionDecision/, "the chat must return the chosen option");
  assert.match(js, /case "permission"/, "the webview must render permission requests");
  assert.match(js, /permission-card/, "permission choices need an inline card");
  assert.match(css, /^\.permission-card \{/m, "the inline permission card needs a style");
  assert.doesNotMatch(
    permission.slice(0, 1800),
    /modal:\s*true/,
    "permission requests must not open a modal popup"
  );
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

  for (const id of ["chips", "usage-bar", "dropzone", "attach-menu", "usage-panel"]) {
    assert.ok(
      new RegExp(`\\.hidden\\s*=|${id}`).test(js),
      `chat.js should still manage #${id}`
    );
  }

  // The override has to sit above the component rules it is undoing.
  const overrideAt = css.indexOf(override[0]);
  for (const selector of [".chips {", ".usage-bar {", ".dropzone {", ".popup {", ".usage-panel {"]) {
    const at = css.indexOf(selector);
    assert.ok(at > -1, `${selector} should exist`);
    assert.ok(at > overrideAt, `${selector} must come after the [hidden] override`);
  }
});

test("each toggled element has exactly one rule block", () => {
  for (const selector of [".dropzone", ".chips", ".usage-bar", ".popup", ".usage-panel"]) {
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

/**
 * Usage has two ways in: the view title bar, and the "Check account usage"
 * button in the model menu footer. The top bar used to carry a third that hit
 * the same command. Both survivors route through refreshUsage, so the handler
 * has to stay even though the top bar no longer posts to it.
 */
test("usage is offered by the view title bar and not duplicated in the top bar", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const titleMenu = pkg.contributes.menus["view/title"] ?? [];
  assert.ok(
    titleMenu.some((item) => item.command === "kiroChat.showUsage"),
    "kiroChat.showUsage must stay in the view/title menu"
  );

  assert.doesNotMatch(provider, /usage-btn/, "the top bar should not carry its own usage button");
  assert.doesNotMatch(js, /usageBtn/, "chat.js should not wire a top bar usage button");
  // `.linkish` used to be this button's private style and was checked here to
  // prove it went with it. The back link in the history list owns it now, so
  // its presence no longer says anything about the usage button.

  // The model menu footer still asks for a refresh, so the handler stays.
  assert.match(js, /type: "refreshUsage"/, "the model menu footer should still ask for usage");
  assert.match(provider, /case "refreshUsage"/, "the provider must still answer refreshUsage");
});

/**
 * The panel is one vertical column: status at the top, the conversation
 * flowing top to bottom, the composer pinned at the bottom. User messages used
 * to be right-aligned bubbles, which gave the transcript two reading axes and
 * made a narrow sidebar feel cramped. Both roles are now full width.
 */
test("the transcript is a single left-aligned column", () => {
  const userRule = css.match(/^\.msg\.user \{[^}]*\}/m);
  assert.ok(userRule, ".msg.user should still be styled");
  assert.doesNotMatch(
    userRule[0],
    /align-self:\s*flex-end/,
    "user messages must not be pulled to the right"
  );
  assert.doesNotMatch(
    userRule[0],
    /max-width:\s*\d+%/,
    "user messages should run the full column width"
  );
});

/**
 * Without the bubble and the right-hand alignment, the only thing separating
 * your words from Kiro's is the label above them. Losing it makes the
 * transcript unreadable, and nothing else would catch that.
 */
test("every message says who wrote it", () => {
  assert.match(js, /msg-role/, "chat.js should label each message with its author");
  assert.match(css, /^\.msg-role \{/m, "the role label needs a style");
});

/**
 * The setup screen used to leave the composer live, so you could type a
 * question and press Send into a Kiro that was not running. The message went
 * nowhere and nothing said why.
 */
test("the composer is dead while setup is on screen", () => {
  assert.match(js, /function setComposerEnabled/, "chat.js needs one place that locks the composer");
  const setup = js.slice(js.indexOf("function renderSetup"));
  assert.match(
    setup.slice(0, 600),
    /setComposerEnabled\(\s*false/,
    "showing setup must disable the composer"
  );
});

/**
 * Each step reports its own progress — waiting, done, failed — so the user can
 * see the panel noticing the install rather than wondering whether to click
 * something. A step rendered without state is a step frozen at "todo".
 */
test("setup steps carry their own state", () => {
  assert.match(js, /dataset\.state/, "chat.js should stamp each step with its state");
  assert.match(css, /\.step\[data-state=/, "the states need to look different");
});

/** The watcher is what makes the setup screen advance on its own. */
test("the provider drives the setup screen with the watcher", () => {
  assert.match(provider, /SetupWatcher/, "the provider should own a SetupWatcher");
  assert.match(provider, /case "signIn"/, "signing in must tell the watcher to retry");
  assert.match(js, /case "setupState"/, "the webview must react to watcher progress");
});

/**
 * The watcher is not the only way Kiro comes up: pressing Connect, or a
 * restart from the title bar, both connect without the watcher saying a word.
 * If only the watcher's "connected" message dismissed the setup screen, those
 * routes left the user staring at install instructions with a dead composer
 * while Kiro sat there connected and ready.
 */
test("a ready session dismisses the setup screen however it connected", () => {
  const handler = js.slice(js.indexOf('case "status":'));
  const body = handler.slice(0, handler.indexOf("break;"));
  assert.match(
    body,
    /leaveSetup\(\)/,
    "reaching ready must drop the setup screen, not just a watcher message"
  );
});

/**
 * Image attachments were shown as filenames because postAttachments stripped
 * the data before the webview ever saw it. Sending a data URI is the whole
 * fix, and dropping it again would silently put the filenames back.
 */
test("image attachments reach the webview as something it can draw", () => {
  assert.match(provider, /previewOf/, "the provider must build a preview for images");
  const posted = provider.slice(provider.indexOf("private postAttachments"));
  assert.match(
    posted.slice(0, 400),
    /preview:/,
    "postAttachments must include the preview, not just the label"
  );
  assert.match(js, /function thumbnail/, "chat.js should render a thumbnail");
  assert.match(css, /^\.thumb \{/m, "the thumbnail needs a size");
});

/** A huge image is not worth pushing through postMessage to draw it small. */
test("an oversized image falls back to a text chip", () => {
  assert.match(provider, /MAX_PREVIEW_BYTES/, "there must be a ceiling on preview size");
  const preview = provider.slice(provider.indexOf("private previewOf"));
  assert.match(
    preview.slice(0, 500),
    /return undefined/,
    "over the ceiling, no preview is sent"
  );
});

/**
 * Kiro binds a session to a folder and confirms loadSession, so history can
 * genuinely resume. Losing the session id would quietly turn every past chat
 * read-only.
 */
test("past chats are stored with what is needed to reopen them", () => {
  assert.match(provider, /sessionId: this\.session\.currentSessionId/);
  assert.match(provider, /HISTORY_KEY/, "history has to be stored somewhere durable");
  assert.match(js, /case "openChat"/, "the webview must react to a chat being opened");
});

/**
 * Starting a new chat used to throw the old one away. Now it is archived
 * first, which is the only reason history has anything in it.
 */
test("starting a new chat keeps the old one", () => {
  const fresh = provider.slice(provider.indexOf("async newSession()"));
  assert.match(
    fresh.slice(0, 400),
    /saveCurrentChat\(\)/,
    "the outgoing chat must be saved before it is cleared"
  );
});

/**
 * Reopening a chat Kiro cannot load still shows the transcript, but replying
 * would silently start a different conversation. The composer says so.
 */
test("a chat that cannot be resumed is read only, not silently broken", () => {
  assert.match(provider, /chatReadOnly/, "the provider must say when a chat cannot resume");
  const handler = js.slice(js.indexOf('case "chatReadOnly":'));
  assert.match(
    handler.slice(0, 400),
    /setComposerEnabled\(\s*false/,
    "a read-only chat must not accept a reply"
  );
});

/**
 * The usage report used to be posted into the conversation as note bubbles,
 * which pushed the chat around and — because it went through recordSimple —
 * got saved into the chat history as if the user had asked for it there. It
 * belongs in a panel you can open and close.
 */
test("the usage report is a panel, not a message in the chat", () => {
  assert.match(provider, /id="usage-panel"/, "there must be somewhere to put the report");
  assert.match(js, /usagePanel/, "chat.js should render the report into the panel");

  const report = js.slice(js.indexOf('case "usageReport"'));
  const body = report.slice(0, 500);
  assert.doesNotMatch(body, /addBubble/, "the report must not be added to the transcript");
  assert.doesNotMatch(body, /recordSimple/, "the report must never reach the saved history");
});

/** Opening it twice should close it; that is what makes it a toggle. */
test("the usage panel toggles", () => {
  assert.match(js, /function toggleUsagePanel/, "there must be one place that toggles it");
  assert.match(js, /case "toggleUsage"/, "the title bar command must reach the toggle");
  assert.match(provider, /toggleUsage/, "the provider must be able to ask for the toggle");
});

/**
 * The file you are looking at goes with your message, the way Copilot Chat
 * does it. Before this it was named in the prompt as prose and never attached,
 * so Kiro knew the filename and could not open it — and nothing on screen said
 * it was happening or let you stop it.
 */
test("the focused file is attached and shown as a chip", () => {
  assert.match(provider, /attachmentsForMessage/, "send must fold in the active file");
  assert.match(provider, /activeFile: this\.activeFile\(\)/, "the chip needs the file");
  assert.match(js, /chip-active/, "chat.js should draw a chip for it");
  assert.match(css, /^\.chip-active \{/m, "the chip needs a style");

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(
    pkg.contributes.configuration.properties["kiroChat.attachActiveFile"],
    "there must be a way to switch it off"
  );
});

/** Dismissing means "not this file", not "never again". */
test("switching files brings the chip back", () => {
  const handler = js.slice(js.indexOf('case "selection":'));
  assert.match(
    handler.slice(0, 700),
    /includeActiveFile = true/,
    "a different file must re-enable the chip"
  );
});

/**
 * kiroChat.sendSelection was declared in package.json and never read anywhere,
 * so the toggle silently did nothing.
 */
test("every declared setting is actually read by the code", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const sources = ["chatViewProvider.ts", "kiroSession.ts", "context.ts", "extension.ts", "lifecycle.ts"]
    .map((f) => fs.readFileSync(path.join(root, "src", f), "utf8"))
    .join("\n");

  for (const key of Object.keys(pkg.contributes.configuration.properties)) {
    const name = key.replace(/^kiroChat\./, "");
    assert.match(
      sources,
      new RegExp(`["']${name}["']`),
      `${key} is offered in settings but nothing reads it`
    );
  }
});

/**
 * A dropped file arrives under several format names at once, and which ones
 * are filled in depends on where the drag came from. Reading only one is how
 * a drop ends up looking as though it did nothing.
 */
test("a drop is read from every format the drag offered", () => {
  assert.match(js, /DROP_FORMATS/, "chat.js should try more than one format");
  for (const format of ["text/uri-list", "resourceurls", "text/plain"]) {
    assert.ok(js.includes(format), `${format} should be among the formats read`);
  }
  assert.match(provider, /parseDroppedPaths/, "the provider parses what arrived");
});

/**
 * A drop that yields nothing has to say so. Without it there is no way to tell
 * a drop that was not understood from one that never reached the panel, and
 * that difference decides where the fix belongs.
 */
test("a drop that yields nothing is logged with what was on offer", () => {
  const handler = provider.slice(provider.indexOf("private async handleDrop"));
  const body = handler.slice(0, 1400);
  assert.match(body, /formats offered/, "the log must name the formats that were available");
  assert.match(body, /appendLine/, "it has to reach the output channel");
});

/** The webview must report even an empty drop, or the log above never runs. */
test("the webview reports a drop even when it read nothing", () => {
  const drop = js.slice(js.indexOf('window.addEventListener("drop"'));
  const body = drop.slice(0, 1800);
  assert.match(body, /types:/, "the offered formats go up with the message");
  assert.doesNotMatch(
    body,
    /if \(values\.length > 0\) vscode\.postMessage/,
    "reporting must not be conditional on having understood the drop"
  );
});

/**
 * A webview cannot accept a drop. VS Code's WebviewElement runs
 *
 *   windowDidDragStart() -> element.style.pointerEvents = "none"
 *
 * for the duration of any drag anywhere in the window, so no drag event ever
 * reaches the panel and nothing inside the webview can change that. Dragging a
 * file in is done on the native chat box instead, via the @kiro participant.
 */
test("dropping files is offered through the native chat box", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.ok(
    (pkg.contributes.chatParticipants ?? []).length > 0,
    "the participant is the only place a drop can land"
  );

  const views = pkg.contributes.views.kiroChat ?? [];
  assert.ok(
    !views.some((v) => v.id === "kiroChat.drop"),
    "the drop-target view was removed; the chat box replaces it"
  );

  const participant = fs.readFileSync(path.join(root, "src", "participant.ts"), "utf8");
  assert.match(participant, /filesFromReferences/, "attached files must reach Kiro");
});

/**
 * Drag a file in, then focus that same file, and the chip row used to show it
 * twice — once as the attachment and once as "the file you are looking at".
 * The extension already dropped the duplicate before sending, so the second
 * chip was claiming something that did not happen.
 */
test("the file you are looking at is not shown twice when already attached", () => {
  assert.match(js, /function samePathish/, "the chips need to compare paths properly");
  const render = js.slice(js.indexOf("function renderChips"));
  assert.match(
    render.slice(0, 900),
    /activeAlreadyAttached/,
    "renderChips must skip the active file when it is already attached"
  );
});

/** Both the live chip and the dismissed "add it back" chip must respect it. */
test("neither form of the active-file chip duplicates an attachment", () => {
  const render = js.slice(js.indexOf("function renderChips"));
  const body = render.slice(0, 2600);
  const guards = body.match(/!activeAlreadyAttached/g) ?? [];
  assert.equal(guards.length, 2, "both the live and the muted chip need the guard");
});
