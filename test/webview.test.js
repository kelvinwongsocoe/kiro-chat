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
const reviewer = fs.readFileSync(path.join(root, "src", "changeReviewer.ts"), "utf8");

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
  assert.match(provider, /sessionId: this\.chatSessionId \?\? this\.session\.currentSessionId/);
  assert.match(provider, /HISTORY_KEY/, "history has to be stored somewhere durable");
  assert.match(js, /case "openChat"/, "the webview must react to a chat being opened");
});

/**
 * Starting a new chat used to throw the old one away. Now it is archived
 * first, which is the only reason history has anything in it.
 *
 * Three paths begin a chat — the + button, Try again on the setup screen, and
 * a panel rebuilt with nothing in it. Two of them used to skip the archiving
 * and the id rotation, so the conversation that followed was written into the
 * previous chat's record and upsert replaced it. They all go through one
 * helper now, and this checks none of them has drifted back out.
 */
test("starting a new chat keeps the old one", () => {
  const fresh = provider.slice(provider.indexOf("private beginFreshChat()"));
  const body = fresh.slice(0, 500);
  assert.match(body, /saveCurrentChat\(\)/, "the outgoing chat must be saved");
  assert.match(body, /this\.chatId = freshId\(\)/, "and the new one must get its own id");
  assert.match(body, /this\.transcript = \[\]/, "and start with an empty transcript");

  for (const [name, start] of [
    ["the + button", "async newSession()"],
    ["Try again on the setup screen", 'case "retry"'],
    ["a panel rebuilt blank", "if (this.everConnected) {"],
  ]) {
    const region = provider.slice(provider.indexOf(start));
    assert.match(
      region.slice(0, 500),
      /beginFreshChat\(\)/,
      `${name} must archive the chat it is replacing`
    );
  }
});

/*
 * Reading a past chat must not rewrite it.
 *
 * `openChat` posts the stored transcript down and only then awaits
 * `session/load`. The webview used to save its state — which reports the
 * transcript back — the instant it received it, and that round trip beats a
 * 30-second ACP request every time. So the record was re-saved while the load
 * was still in flight: its timestamp jumped to now, so a chat from last week
 * moved to Today merely for being opened, and its session id was overwritten
 * with whichever session was still running, which was the *previous* chat's.
 * Reopening it after that resumed the wrong conversation.
 */
test("opening a past chat does not report its transcript back", () => {
  const handler = js.slice(js.indexOf('case "openChat":'));
  const body = handler.slice(0, handler.indexOf("case \"chatReadOnly\""));
  assert.match(
    body,
    /saveState\(false\)/,
    "a transcript handed to us by the extension must not be sent back"
  );
  assert.doesNotMatch(
    body,
    /saveState\(\)/,
    "reporting it would re-save the record we were just given"
  );
  assert.match(
    js,
    /function saveState\(report\)/,
    "saveState has to be able to persist locally without reporting"
  );

  // And the provider pins the chat's own session before anything can report.
  const open = provider.slice(provider.indexOf("private async openChat("));
  const pin = open.indexOf("this.chatSessionId = record.sessionId");
  const post = open.search(/this\.post\(\{\s*type: "openChat"/);
  assert.ok(pin >= 0, "openChat must pin the session the record belongs to");
  assert.ok(post >= 0, "openChat must tell the webview about the chat");
  assert.ok(pin < post, "it must be pinned before the webview is told, not after");
});

/*
 * The keep-or-undo bar belongs to the turn that raised it. Opening a different
 * chat used to leave it pinned above the composer, offering to undo edits made
 * in a conversation that is no longer on screen.
 */
test("opening a past chat clears the other chat's pending changes", () => {
  const handler = js.slice(js.indexOf('case "openChat":'));
  const body = handler.slice(0, handler.indexOf("case \"chatReadOnly\""));
  assert.match(body, /pendingReview = null/);
  assert.match(body, /pendingChanges = null/);
  assert.match(body, /renderChangeBar\(\)/);
});

/*
 * Only the tail of a long chat is stored. Restoring it silently would show a
 * conversation that appears to begin in the middle.
 */
test("a chat stored as only its tail says so", () => {
  assert.match(js, /historyTruncated = message\.truncated === true/, "on open");
  assert.match(js, /truncated: historyTruncated/, "and when reporting back");
  const restore = js.slice(js.indexOf("function restoreHistory(saved)"));
  assert.match(
    restore.slice(0, 600),
    /if \(historyTruncated\)[\s\S]*history-trimmed/,
    "a trimmed transcript must say so where it is drawn"
  );
  assert.match(css, /^\.history-trimmed \{/m, "the note needs a rule");
  assert.match(provider, /truncated: this\.transcriptTruncated/, "and it must be stored");
});

/*
 * Every save serialises every chat, and the records hold whole transcripts.
 * Reading and writing the memento per message moved megabytes a turn.
 */
test("saving a chat is debounced, and reads the list at write time", () => {
  assert.match(provider, /private scheduleFlush\(\): void/);
  const flush = provider.slice(provider.indexOf("private flushChats(): void"));
  const body = flush.slice(0, flush.indexOf("\n  }"));
  // Holding the whole list in memory instead would let a second VS Code
  // window's saves be overwritten by this one's stale copy.
  assert.match(
    body,
    /upsertRecord\(this\.allChats\(\), record\)/,
    "the stored list must be re-read when the pending chat is written"
  );
  assert.doesNotMatch(provider, /private chats: ChatRecord\[\]/, "and never cached");

  const dispose = provider.slice(provider.indexOf("dispose(): void {"));
  assert.match(
    dispose.slice(0, 300),
    /flushChats\(\)/,
    "a debounced save must not be lost to the window closing"
  );
  // A list that leaves out the chat you are in reads as a bug.
  const list = provider.slice(provider.indexOf("private postHistory(): void"));
  assert.match(list.slice(0, 400), /flushChats\(\)/);
});

/*
 * The list's own affordances. Starting a chat is deliberately NOT one of them:
 * the title bar already has that button, and a second one in the list is a
 * duplicate control competing with the rows.
 */
test("the past-chats list can be searched and escaped", () => {
  assert.match(js, /type: "requestHistory"/, "the list must ask for current data");
  assert.match(provider, /case "requestHistory"/, "and the provider must answer");
  assert.match(js, /history-search/, "a list of repeated titles needs a filter");

  const escape = js.slice(js.indexOf('if (event.key !== "Escape") return;'));
  assert.match(
    escape.slice(0, 400),
    /closeHistory\(\)/,
    "Escape must leave the list, like every other overlay in the editor"
  );

  assert.match(js, /history-preview/, "identical titles need the newest line to tell them apart");
  assert.match(provider, /preview: previewOf\(/, "which the provider has to send");
  assert.match(css, /^\.history-preview \{/m);
  assert.match(css, /^\.history-search \{/m);

  // Deleting is one click. The × keeps out of the way until the row is
  // pointed at, so it is never under the cursor of someone aiming at the
  // chat beside it — and `visibility`, so the row does not resize on hover.
  assert.match(js, /act === "delete"/);
  assert.doesNotMatch(js, /confirmDelete/, "deleting was asked for direct, with no prompt");
  assert.doesNotMatch(js, /type: "newChat"/, "the title bar owns starting a chat");
  assert.doesNotMatch(provider, /case "newChat"/, "so the provider must not carry a dead case");
  const remove = css.slice(css.indexOf(".history-delete {"));
  assert.match(remove.slice(0, 500), /visibility: hidden/);
});

/*
 * The open chat used to paint as a solid selection block, which repaints the
 * preview and the timestamp in the selection foreground — the muted greys
 * that make them read as secondary have nothing to be muted against there.
 * A tint plus an accent bar keeps the row's own hierarchy.
 */
test("the row styling is a tint and an accent, not a solid block", () => {
  const current = css.slice(css.indexOf(".history-row.current {"));
  assert.doesNotMatch(
    current.slice(0, 200),
    /list-activeSelectionBackground/,
    "the solid selection block flattens the row's secondary text"
  );
  assert.match(css, /^\.history-row\.current::before \{/m, "the accent bar");
  // Hover and the delete button move, so they need a transition or they snap.
  const row = css.slice(css.indexOf(".history-row {"));
  assert.match(row.slice(0, 300), /transition:/);
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




/**
 * Keep-or-undo lives above the message box, not in the transcript.
 *
 * It appears the moment the inline diff opens, so both routes are open at
 * once: decide each hunk in the diff, or take the whole file from here. Inside
 * the transcript it would scroll away exactly when it is needed, and it has to
 * stay put while the user reads the diff in another tab.
 */
test("keep or undo is pinned above the composer, outside the transcript", () => {
  assert.match(provider, /id="change-bar"/, "the bar needs its own element");
  // Before #chips, so it sits between the transcript and the message box.
  const bar = provider.indexOf('id="change-bar"');
  const chips = provider.indexOf('id="chips"');
  const messages = provider.indexOf('id="messages"');
  assert.ok(bar > messages && bar < chips, "the bar belongs between the transcript and the chips");

  assert.match(css, /^\.change-bar \{/m, "the bar needs a style");
  assert.doesNotMatch(js, /messagesEl\.appendChild\(card\)/, "it must not go in the transcript");
});

/** It shows while the diff is open, not only after the turn has finished. */
test("the bar appears as soon as the review opens", () => {
  assert.match(provider, /onReviewActive/, "the provider must hear about an open review");
  assert.match(js, /case "reviewActive"/, "and the webview must show it");
  assert.match(
    reviewer,
    /onDidChangeActiveReview/,
    "the reviewer must announce when a review is on screen"
  );
});

/*
 * Every message the provider posts about changes needs a handler here.
 *
 * The webview half of the bar went missing once. Nothing failed loudly: the
 * extension went on announcing reviews and finished turns into a switch that
 * ignored them, so no card ever appeared and the only way to answer an edit
 * was to hunt down the diff tab. A posted message with no case is silent.
 */
test("the webview handles every change message the provider posts", () => {
  for (const type of ["reviewActive", "turnChanges", "changesUndone"]) {
    assert.match(
      provider,
      new RegExp(`type: "${type}"`),
      `the provider posts ${type}`
    );
    assert.match(js, new RegExp(`case "${type}"`), `so the webview must handle ${type}`);
  }
  assert.match(js, /function renderChangeBar\(/, "the bar has to be drawn somewhere");
});

/** From the bar, Keep and Reject drive the open review rather than the turn. */
test("the bar drives the open review when there is one", () => {
  assert.match(provider, /acceptActiveReview\(\)/);
  assert.match(provider, /rejectActiveReview\(\)/);
  assert.match(reviewer, /async acceptActive\(\)/);
  assert.match(reviewer, /async rejectActive\(\)/);
});

/** Clicking either twice would act on decisions already consumed. */
test("the bar's buttons cannot be fired twice", () => {
  const render = js.slice(js.indexOf("function renderChangeBar"));
  const body = render.slice(0, 2600);
  assert.match(body, /keep\.disabled = true/);
  assert.match(body, /undo\.disabled = true/);
});
