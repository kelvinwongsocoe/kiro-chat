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
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

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

  // The override has to sit above the component rules it is undoing. `.icon`
  // joined this list when Stop became an icon button: it is toggled with
  // `hidden` and now carries `display: inline-flex`.
  const overrideAt = css.indexOf(override[0]);
  for (const selector of [
    ".chips {",
    ".usage-bar {",
    ".dropzone {",
    ".popup {",
    ".usage-panel {",
    ".icon {",
  ]) {
    const at = css.indexOf(selector);
    assert.ok(at > -1, `${selector} should exist`);
    assert.ok(at > overrideAt, `${selector} must come after the [hidden] override`);
  }
  assert.match(js, /stopBtn\.hidden = /, "Stop is toggled with the hidden attribute");
});

/*
 * The row was sized three different ways — the attach button by fixed pixels,
 * the pickers by their own padding, Send by the global button padding — so
 * nothing in it lined up.
 */
test("every control in the composer row is one height", () => {
  assert.match(css, /\.composer-row \{[^}]*--control-h: \d+px/);
  /*
   * One selector covering every control, not a list of paths to each of them.
   * The enumerated version only held the controls it happened to name, so one
   * moved into a different wrapper would quietly drop out and go back to
   * sizing itself.
   */
  const rule = css.match(/\.composer-row :is\(([^)]*)\) \{([^}]*)\}/);
  assert.ok(rule, "the row has to hand its height to every control at once");
  for (const cls of [".icon", ".mode-btn", ".model-btn"]) {
    assert.ok(rule[1].includes(cls), `${cls} must be covered by that one rule`);
  }
  assert.match(rule[2], /height: var\(--control-h\)/);
  assert.match(rule[2], /min-height: var\(--control-h\)/, "so content cannot push one taller");

  // Square: the icon buttons take their width from the same number.
  assert.match(css, /^\.icon \{[^}]*width: var\(--control-h/m);
});

/*
 * A chevron on the right said only "this opens", which a click discovers
 * anyway, while costing width in a panel that has none to spare. The icon
 * leads instead, and it says which picker this is.
 */
test("the pickers lead with an icon and Send and Stop are icons", () => {
  const row = provider.slice(provider.indexOf('<div class="composer-row">'));
  const markup = row.slice(0, row.indexOf("</div>\n  </form>"));
  assert.doesNotMatch(markup, /class="caret"/, "no chevrons in the composer row");
  assert.match(markup, /<svg class="btn-icon"[\s\S]*?<span id="mode-label">/, "icon before label");
  assert.match(markup, /<svg class="btn-icon"[\s\S]*?<span id="model-label">/);

  // A button with no text needs a name for anyone not looking at it.
  for (const id of ["send", "stop"]) {
    const button = markup.slice(markup.indexOf(`id="${id}"`));
    assert.match(button.slice(0, 400), /aria-label="/, `#${id} must be labelled`);
    assert.match(button.slice(0, 400), /<svg /, `#${id} must be an icon`);
  }
  assert.doesNotMatch(markup, />Send</, "Send is no longer a word");
  assert.doesNotMatch(markup, />Stop</);
});

test("each toggled element has exactly one rule block", () => {
  for (const selector of [".dropzone", ".chips", ".usage-bar", ".popup", ".usage-panel"]) {
    const matches = css.match(new RegExp(`^\\${selector} \\{`, "gm")) ?? [];
    assert.equal(matches.length, 1, `${selector} is defined ${matches.length} times`);
  }
});

/*
 * Every plain-looking button has to cancel the global button hover as well as
 * the global button background.
 *
 * `button { background: var(--vscode-button-background) }` is undone by a
 * class rule, but `button:hover` is a type plus a pseudo-class — specificity
 * (0,1,1) — and beats any single class. So a button that only sets
 * `background: none` sits transparent at rest and then paints solid primary
 * blue the moment the pointer crosses it. That has now shipped three times:
 * the usage strip, the review summary line, and the past-chats rows, where it
 * covered the row's own hover tint with a blue slab.
 */
test("a button styled to look plain cancels the global hover too", () => {
  // Comments sit between rules, so they land in the selector unless dropped.
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const hovered = new Set();
  const plain = [];
  for (const [, rawSelector, body] of rules) {
    for (const selector of rawSelector.split(",").map((s) => s.trim().replace(/\s+/g, " "))) {
      if (selector.includes(":hover")) hovered.add(selector.replace(":hover", ""));
      // Only the ones that are buttons; `background: none` on a <code> block
      // has no global rule to fight.
      if (/background:\s*none/.test(body) && /border:\s*none/.test(body)) {
        plain.push(selector);
      }
    }
  }
  assert.ok(plain.length >= 4, `expected several plain buttons, found ${plain.length}`);
  const missing = plain.filter((selector) => !hovered.has(selector));
  assert.deepEqual(
    missing,
    [],
    `these paint solid blue on hover because nothing outranks button:hover: ${missing.join(", ")}`
  );
});

/*
 * A selection always comes from the file you are looking at, so while one is
 * being sent the chip row named the same file twice — "media/chat.js" beside
 * "media/chat.js:26-26  1 line". The narrower chip says everything the
 * broader one did, so it stands for both; switch the selection off and the
 * file chip comes back, because then it is the only thing still going.
 */
test("the file chip and the selection chip do not both name the same file", () => {
  assert.match(
    js,
    /const sendingSelection = Boolean\(\s*\n?\s*selection && selection\.hasSelection && includeSelection/,
    "whether the highlighted lines are going is one question"
  );
  assert.match(
    js,
    /const selectionCoversActiveFile = sendingSelection && includeActiveFile;/,
    "and whether the selection chip may stand in for the file chip is another"
  );
  const render = js.slice(js.indexOf("function renderChips()"));
  const body = render.slice(0, render.indexOf("\n  function "));
  assert.match(body, /if \(selectionCoversActiveFile\) \{/, "which suppresses the file chip");
  assert.doesNotMatch(body, /chip-count/, "the range already says how many lines it is");
  assert.doesNotMatch(body, /lineCount/);
  assert.doesNotMatch(css, /\.chip-count/, "and the rule for it is gone too");
  assert.doesNotMatch(provider, /lineCount:/, "so the provider need not send it");

  // A sidebar is narrow, and the folder is one the user is already in.
  assert.match(js, /function fileName\(pathish\)/, "chips show the name, not the path");
  assert.match(body, /fileName\(selection\.relativePath\)/);
  assert.match(body, /fileName\(activeFile\.label\)/);

  /*
   * And the same in the sent message, which had its own copy of the problem:
   * a message sent with a highlight carried both "media/chat.js" and
   * "media/chat.js:23-27" under it — the same file twice, one of them saying
   * strictly less.
   */
  const bubble = js.slice(js.indexOf("function addUserBubble(message)"));
  const tags = bubble.slice(0, bubble.indexOf("messagesEl.appendChild(node)"));
  assert.match(tags, /samePathish\(a\.label, selected\)/, "the range stands in for the file");
  // Only for the file that was added automatically, though. One attached by
  // hand is a separate thing the user did and is still sent as its own link,
  // so hiding it would leave no record in the transcript that it went.
  assert.match(
    tags,
    /a\.source === "active" && samePathish/,
    "and only the automatic one may be stood in for"
  );
  assert.match(provider, /source: a\.source \?\? "user"/, "so the provider has to say which");
  assert.match(tags, /replace\(\/:\\d\+-\\d\+\$\/, ""\)/, "which means stripping the range off");
  assert.match(tags, /fileName\(a\.label\)/, "and both are named, not pathed");
  assert.match(tags, /fileName\(selected\)/);
});

/*
 * The selection chip reports the highlight; it is not a control.
 *
 * Its × switched off sending the highlighted code, which left the editor
 * showing a selection the panel had quietly decided not to send — two places
 * disagreeing, with nothing on screen saying which was true. Clearing the
 * highlight is the one way to stop it, and that is the editor's job.
 */
test("the selection chip cannot be dismissed while the code is highlighted", () => {
  const render = js.slice(js.indexOf("function renderChips()"));
  const body = render.slice(0, render.indexOf("\n  function "));
  // These files are CRLF, so slice on a pattern rather than a literal newline.
  const from = body.search(/if \(sendingSelection\) \{\s*\n\s*const chip/);
  assert.ok(from > -1, "the selection chip block should be findable");
  const chip = body.slice(from);
  const to = chip.search(/for \(const a of attachments\)/);
  assert.ok(to > -1, "and it should end before the attachment chips");
  const upToNext = chip.slice(0, to);
  assert.doesNotMatch(upToNext, /chip-x/, "the selection chip must carry no dismiss button");
  assert.doesNotMatch(upToNext, /includeSelection = false/);
  assert.doesNotMatch(body, /includeSelection = true/, "and no add-it-back chip either");

  // With no per-message choice left, the setting is the only thing deciding.
  assert.doesNotMatch(js, /restoredChoice/, "a restored panel has no choice to protect");
  assert.match(
    js,
    /if \(typeof message\.sendSelection === "boolean"\) \{/,
    "so the setting always wins"
  );
  assert.doesNotMatch(
    manifest.contributes.configuration.properties["kiroChat.sendSelection"].description,
    /per message using the chip/,
    "and the setting must not promise a toggle that is gone"
  );
});

/*
 * A code block you cannot get out of the panel is half a code block.
 *
 * The button has to be wired by delegation: a streaming reply rebuilds its
 * markdown on every frame, so a listener bound to the button itself would be
 * thrown away several times a second and the control would go dead mid-reply.
 */
test("code blocks can be copied", () => {
  assert.match(js, /class="code-block"/, "the block needs a wrapper to position on");
  assert.match(js, /class="code-copy"/);
  assert.match(css, /^\.code-block \{[^}]*position: relative/m);
  assert.match(css, /^\.code-copy \{/m);

  assert.match(
    js,
    /messagesEl\.addEventListener\("click"/,
    "the copy must be delegated from the transcript, not bound per button"
  );
  const handler = js.slice(js.indexOf('messagesEl.addEventListener("click"'));
  const body = handler.slice(0, handler.indexOf("\n  });"));
  assert.match(body, /closest\(["']\.code-copy["']\)/);
  // Reading the rendered element means what is copied is what is on screen,
  // with no second escaping pass to get wrong.
  assert.match(body, /querySelector\("code"\)/);
  assert.match(body, /copyText\(code\.textContent\)/);
  assert.match(body, /isConnected/, "a mid-render button must not be written to");

  // Something has to happen when the clipboard is refused, or the button
  // looks broken.
  assert.match(body, /selectNodeContents\(code\)/, "failing over to a selection");
  assert.match(js, /document\.execCommand\("copy"\)/, "and to the older API");

  // Hover is not the only way to reach it.
  assert.match(css, /\.code-copy:focus-visible/);
});

/*
 * Between pressing Send and the first token — however long Kiro spends
 * thinking and running tools — the transcript said nothing at all, so a slow
 * turn was indistinguishable from a dead one. The only sign was the status
 * dot at the very top of the panel, nowhere near where the answer lands.
 */
/*
 * Windows line endings used to leave a carriage return inside every code
 * block. The fence pattern consumed `\n` after the language but not `\r\n`,
 * so the `\r` was captured as the first character of the code — and `<pre>`
 * renders a lone `\r` as a break, so every snippet came out with a blank line
 * above and below it that was not even visibly whitespace.
 */
test("code blocks survive Windows line endings", () => {
  const render = js.slice(js.indexOf("function renderMarkdown(rawSource)"));
  const body = render.slice(0, render.indexOf("\n  // ---"));
  assert.match(
    body,
    /String\(rawSource\)\.replace\(\/\\r\\n\?\/g, "\\n"\)/,
    "line endings must be normalised before anything parses the text"
  );
  // The newline before a closing fence belongs to the fence, and so does any
  // indent in front of it.
  assert.match(body, /code\.replace\(\/\\n\[ \\t\]\*\$\/, ""\)/);
});

/*
 * A fence only opens a block at the start of a line.
 *
 * Matching ``` anywhere meant a run of backticks *inside a sentence* — "uses
 * longer fences (````)", a shell snippet quoted inline, anything discussing
 * markdown — opened a code block and swallowed the whole rest of the reply
 * into it as code. The more a reply talked about code, the more likely it was
 * to be destroyed.
 */
test("backticks inside a sentence do not open a code block", () => {
  const render = js.slice(js.indexOf("function renderMarkdown(rawSource)"));
  const body = render.slice(0, render.indexOf("\n  // ---"));
  const fence = body.match(/const FENCE = (\/.*\/gm);/);
  assert.ok(fence, "the fence pattern should be named and anchored");

  assert.match(fence[1], /^\/\^\[ \\t\]\{0,3\}```/, "the opening fence must start a line");
  assert.match(fence[1], /\^\[ \\t\]\{0,3\}```\[ \\t\]\*\$/, "and so must the closing one");
  assert.ok(fence[1].endsWith("/gm"), "which needs the multiline flag");

  /*
   * `$` under `m` means end of *line*, so using it for the unterminated case
   * would cut every block at its first newline — and a streaming reply is
   * unterminated for as long as it is arriving.
   */
  assert.match(fence[1], /\(\?!\[\\s\\S\]\)/, "end-of-string, not end-of-line");

  // Exercise it, so the assertions above are about behaviour and not shape.
  const pattern = new RegExp(fence[1].slice(1, -3), "gm");
  const inline = "uses longer fences (````)\n3. next item\n4. another";
  assert.equal(pattern.test(inline), false, "a mid-line run of backticks is not a fence");
  pattern.lastIndex = 0;
  assert.equal(pattern.test("```js\nlet a = 1;\n```"), true, "a real fence still opens");
  pattern.lastIndex = 0;
  assert.equal(pattern.test("```js\nlet a = 1;"), true, "and an unfinished one still renders");
});

/**
 * The markdown renderer, lifted out of `chat.js` and actually run.
 *
 * Everything from `escapeHtml` to the end of `renderMarkdown` is contiguous
 * and depends on nothing outside itself, so it evaluates on its own. Asserting
 * on the shape of the source can only say the code looks right; a reply
 * arriving unreadable is a behaviour, and these are the tests that can check
 * the behaviour rather than the spelling.
 */
function loadRenderer() {
  const from = js.indexOf("function escapeHtml");
  const to = js.indexOf("async function copyText");
  assert.ok(from > -1 && to > from, "the renderer should be findable in chat.js");
  return new Function(js.slice(from, to) + "\nreturn renderMarkdown;")();
}

/*
 * Tables came out as a wall of pipes.
 *
 * Every row fell through to the paragraph branch, so each became its own <p>
 * with a margin between, and `|---|---|` printed as literal dashes. Agents
 * answer with tables constantly — any "here is the mapping" reply is one — so
 * this was most of a long answer arriving unreadable.
 */
test("a pipe table is rendered as a table", () => {
  const html = loadRenderer()(
    "Here is the mapping:\n\n" +
      "| Case | Condition |\n|---|---|\n" +
      "| SOURCE_NOT_RENEWABLE | `isRenewableSource()` is false |\n" +
      "| RENEWAL_IN_PROGRESS | a sibling exists |\n\n" +
      "Note the order."
  );
  assert.match(html, /<table>/, "a pipe table has to become a table");
  assert.equal((html.match(/<tr>/g) ?? []).length, 3, "a header row and two body rows");
  assert.match(html, /<th>Case<\/th>/);
  assert.match(
    html,
    /<td><code>isRenewableSource\(\)<\/code> is false<\/td>/,
    "cells are inline markdown, not flat text"
  );
  assert.doesNotMatch(html, /\|---\|/, "and the delimiter row is not printed as content");
  assert.doesNotMatch(html, /<p>\|/, "no row may fall through to a paragraph");

  // A table is the one thing in a reply with a width of its own, and this
  // panel is often a sidebar. It scrolls inside itself or it widens the
  // whole transcript.
  assert.match(html, /class="table-wrap"/);
  assert.match(css, /^\.table-wrap \{/m);
  assert.match(css, /overflow-x: auto/);
});

/*
 * A table asks for the width its content needs — no more, no less.
 *
 * Two versions of this were wrong in opposite directions.
 * `overflow-wrap: anywhere` broke words at any character, so the first column
 * — in a mapping table always an identifier — rendered as "SOURCE_NOT_REN /
 * EWABLE". A flat `min-width: 8em` per cell fixed that and priced every table
 * the same, so "| a | b | c |" scrolled in a panel with room to spare.
 *
 * Letting the content ask for its own width does both, and is the browser's
 * default: the job is to not override it.
 */
test("a table is as wide as its content, and never breaks a word", () => {
  const rule = css.slice(css.indexOf(".table-wrap th,"));
  // Declarations only. The comment inside this rule names the values it
  // rejected, and reading those as declarations failed the test on its own
  // explanation.
  const body = rule.slice(0, rule.indexOf("\n}")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(body, /overflow-wrap: normal/, "a word is never broken");
  assert.match(body, /word-break: normal/);
  assert.doesNotMatch(body, /overflow-wrap: (anywhere|break-word)/, "not even as a last resort");
  assert.doesNotMatch(body, /min-width:/, "and a short table must not be priced like a long one");
});

/*
 * A rule under the header and hairlines between rows, not a full grid.
 * Bordering every cell draws the container rather than the content, and at
 * chat width the vertical lines are pure noise.
 */
test("a table reads as prose, not as a spreadsheet", () => {
  assert.match(css, /^\.table-wrap th \{[^}]*border-bottom:/m, "the header gets a rule");
  assert.match(css, /^\.table-wrap tbody tr \+ tr td \{[^}]*border-top:/m, "rows get hairlines");
  const cells = css.slice(css.indexOf(".table-wrap th,"));
  assert.doesNotMatch(
    cells.slice(0, cells.indexOf("}")),
    /^\s*border: /m,
    "and no cell draws a box around itself"
  );
  assert.doesNotMatch(css, /\.table-wrap tbody tr:nth-child/, "no zebra striping either");
});

test("column alignment markers are honoured", () => {
  const html = loadRenderer()("| L | C | R |\n|:---|:---:|---:|\n| a | b | c |");
  assert.match(html, /<th style="text-align:center">C<\/th>/);
  assert.match(html, /<th style="text-align:right">R<\/th>/);
  assert.match(html, /<td style="text-align:right">c<\/td>/, "the body follows the header");
  assert.doesNotMatch(html, /text-align:left/, "left is the default, not a style to write");
});

/*
 * The guard matters more than the feature. A line with a pipe in it above a
 * line of dashes is ordinary prose over a horizontal rule, and turning that
 * into a table would be a worse bug than the one being fixed — which is why
 * the delimiter's cell count has to match the header's, as GFM says.
 */
test("prose that merely contains a pipe is not a table", () => {
  const render = loadRenderer();
  assert.doesNotMatch(render("use grep | wc -l for this\n---\nnext"), /<table>/);
  assert.doesNotMatch(
    render("| a | b | c |\n|---|---|\n| 1 | 2 | 3 |"),
    /<table>/,
    "the delimiter has to describe the same number of columns"
  );
  assert.doesNotMatch(
    render("```js\nconst a = b | c;\n```"),
    /<table>/,
    "and a fenced block is never read for tables at all"
  );
});

test("a short row is padded rather than dropped", () => {
  // A ragged table still reads; a missing cell shifts every column after it.
  const html = loadRenderer()("| a | b | c |\n|---|---|---|\n| 1 |");
  assert.equal((html.match(/<td/g) ?? []).length, 3, "the row keeps its columns");
});

test("tables without outer pipes still count", () => {
  assert.match(loadRenderer()("a | b\n--- | ---\n1 | 2"), /<th>a<\/th>/);
});

/*
 * Kiro says something, calls a tool, then says something else — and all of it
 * was appended to one buffer with nothing between, so the two ran together
 * with no space at all: "…rather than guessing from names.I notice
 * RENEWAL_WINDOW_CLOSED…". Nothing in the stream separates one message from
 * the next, but a step starting is a boundary that can be seen.
 */
test("text that resumes after a tool step starts a new paragraph", () => {
  assert.match(js, /let breakBeforeText = false;/, "the boundary needs somewhere to live");

  const chunk = js.slice(js.indexOf('case "chunk": {'));
  const chunkBody = chunk.slice(0, chunk.indexOf('case "tool": {'));
  assert.ok(
    chunkBody.includes("if (breakBeforeText && buffer && !/\\n\\s*$/.test(buffer))"),
    "a break is inserted only when there is text to break from, and none already"
  );
  assert.ok(chunkBody.includes('buffer += "\\n\\n";'), "and it is a paragraph break");
  assert.match(chunkBody, /breakBeforeText = false;/, "consumed, so it fires once");

  /*
   * Set where a row is *created*, never on a status update for a step already
   * on screen — those arrive while text is still streaming and would split a
   * sentence down the middle, which is the same bug pointing the other way.
   */
  const tool = js.slice(js.indexOf('case "tool": {'));
  const toolBody = tool.slice(0, tool.indexOf("\n      case "));
  const created = toolBody.slice(toolBody.indexOf("if (!row) {"), toolBody.indexOf("startThinking()"));
  assert.match(created, /breakBeforeText = true;/, "a step Kiro has just decided on");
  assert.equal(
    (toolBody.match(/breakBeforeText = true;/g) ?? []).length,
    1,
    "and only there — a status update for a listed step is not a boundary"
  );
});

test("the transcript says when Kiro is working, and for how long", () => {
  assert.match(js, /function startThinking\(\)/);
  assert.match(js, /function stopThinking\(/);
  assert.match(js, /function elapsedText\(ms\)/, "a stuck turn is told from a slow one by time");
  assert.match(css, /^\.steps-time \{/m);

  const sent = js.slice(js.indexOf('case "userMessage":'));
  assert.match(
    sent.slice(0, 400),
    /startThinking\(\)/,
    "it must go in when the message is sent, not when the reply starts"
  );

  // The clock has to keep running while the reply streams — that is the whole
  // point of it — so only the end of the turn stops it.
  const start = js.slice(js.indexOf("function startThinking()"));
  assert.match(start.slice(0, 800), /setInterval\(tick, 1000\)/);
  const chunk = js.slice(js.indexOf('case "chunk": {'));
  assert.doesNotMatch(
    chunk.slice(0, 500),
    /stopThinking/,
    "the first token does not mean the turn is over"
  );
  const finish = js.slice(js.indexOf("function finishAgentBubble()"));
  assert.match(finish.slice(0, 400), /stopThinking\(current\)/, "turnEnd and errors do");
  assert.match(finish.slice(0, 400), /clearInterval/, "a discarded bubble must not tick on");

  // An empty bubble showing a blinking cursor claims a reply has begun.
  const bubble = js.slice(js.indexOf("function ensureAgentBubble()"));
  assert.doesNotMatch(
    bubble.slice(0, 900),
    /body\.className = "body cursor"/,
    "the cursor belongs to text that exists"
  );
  // The case, not a fixed 500 characters of it — a comment added inside was
  // enough to push the line out of the window and fail this for nothing.
  assert.match(
    chunk.slice(0, chunk.indexOf('case "tool": {')),
    /classList\.toggle\("cursor", Boolean\(buffer\.trim\(\)\)\)/,
    "and not to an empty buffer"
  );

  // Decoration only: the words carry the state on their own.
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

/*
 * A turn can run a dozen tools, and listing them all pushed the answer off
 * the screen before it arrived. They fold behind one line of state.
 */
/*
 * "Working…" does not answer the question you actually have while waiting,
 * which is *what is it doing* — reading a file, searching, writing one. The
 * newest unfinished step is the answer, and it goes on the same line the list
 * unfolds from rather than costing a second one.
 */
test("the header names the step Kiro is on", () => {
  assert.match(js, /function updateStepsLabel\(bubble\)/);
  const update = js.slice(js.indexOf("function updateStepsLabel(bubble)"));
  const body = update.slice(0, update.indexOf("\n  /**"));
  assert.match(body, /steps\.length === 0/, "before any step it is still Working…");
  assert.match(
    body,
    /\.reverse\(\)\s*\n?\s*\.find\(\(t\) => t\.status !== "completed" && t\.status !== "failed"\)/,
    "the newest unfinished step is the one being worked on"
  );
  assert.match(body, /head\.title = step\.title/, "the line ellipsises, so keep the whole of it");

  const tool = js.slice(js.indexOf('case "tool": {'));
  const handler = tool.slice(0, tool.indexOf('case "permission"'));
  assert.match(handler, /updateStepsLabel\(bubble\)/, "every tool update refreshes it");
  assert.match(
    handler,
    /startThinking\(\)/,
    "a tool can arrive without a userMessage, so the header starts here too"
  );
});

/*
 * A finished turn is a single fact, so it reads as one sentence — "Completed
 * 2 steps in 7s". While the turn runs the halves are separate, because what
 * it is doing and how long it has been at it are two different things; once
 * it is over, splitting them left a label with a stray number after it.
 */
test("a finished turn reads as one sentence", () => {
  const stop = js.slice(js.indexOf("function stopThinking(bubble)"));
  const body = stop.slice(0, stop.indexOf("\n  /**"));
  assert.match(body, /`Completed \$\{steps\}\$\{took_\}`/);
  assert.match(body, /group\.time\.textContent = ""/, "the clock half is folded in");
  assert.doesNotMatch(js, /Worked for/, "that wording is gone for good");

  /*
   * A turn that ran no steps shows no header. There used to be a second shape
   * for that case — a line with the chevron slot standing empty, at a
   * different indent from the ordinary one — and two versions of the same
   * line read as a mistake.
   */
  assert.match(body, /if \(count === 0\) \{[\s\S]*?group\.steps\.hidden = true;[\s\S]*?return;/);
  assert.doesNotMatch(js, /classList\.add\("bare"\)/, "the second shape is gone");
  assert.doesNotMatch(css, /\.steps\.bare/);

  // A stored chat has no timing, so the sentence stops short rather than
  // claiming a duration it does not have.
  const restore = js.slice(js.indexOf("function restoreHistory(saved)"));
  assert.match(restore.slice(0, 1400), /"Completed 1 step" : `Completed \$\{steps\.length\} steps`/);
});

test("the steps fold away behind the header", () => {
  assert.match(js, /function buildSteps\(\)/);
  assert.match(css, /^\.steps-head \{/m);
  assert.match(css, /^\.steps-list \{/m);
  const build = js.slice(js.indexOf("function buildSteps()"));
  const body = build.slice(0, build.indexOf("\n  /**"));
  assert.match(body, /list\.hidden = true/, "closed to begin with");
  assert.match(body, /aria-expanded/, "and it has to say so");

  /*
   * The header must exist whenever a step ran — that is the log of what Kiro
   * did, and it is the one thing that must never go missing. It used to be
   * revealed as a side effect of `startThinking`, which does nothing once the
   * clock is already running, so what guaranteed the log was visible was a
   * call that had usually already happened.
   */
  const tool = js.slice(js.indexOf('case "tool": {'));
  const handler = tool.slice(0, tool.indexOf('case "permission"'));
  assert.match(handler, /bubble\.group\.steps\.hidden = false;/);
  assert.doesNotMatch(handler, /group\.open\(true\)/, "but it stays folded by default");

  // Nothing folds a list the user opened; that choice is theirs to undo.
  assert.match(body, /steps\.dataset\.pinned = "1"/);
  const stop = js.slice(js.indexOf("function stopThinking(bubble)"));
  const stopBody = stop.slice(0, stop.indexOf("\n  /**"));
  assert.doesNotMatch(stopBody, /group\.open\(/, "the turn ending must not close it either");
  assert.match(stopBody, /group\.steps\.hidden = false/, "and the log survives the turn");

  // A permission card inside a folded list is one the user cannot answer,
  // and the turn would hang waiting for them.
  const card = js.slice(js.indexOf("function addPermissionCard(permission)"));
  assert.match(
    card.slice(0, 2200),
    /root\.insertBefore\(card, bubble\.body\)/,
    "the permission card must never go inside the steps list"
  );
});

/*
 * "Reading chat.js — running" wrote the state in the same grey prose as the
 * name, so a step still going looked like one that had finished. Live and
 * restored rows go through one renderer, or the two drift.
 */
test("a tool row shows its state, without a column of ticks mid-turn", () => {
  assert.match(js, /function renderToolRow\(row, tool, phase = "live"\)/);
  assert.match(css, /^\.tool-icon \{/m);
  assert.match(css, /@keyframes tool-spin/);

  // No marks on finished steps: a tick beside every completed row is a column
  // of decoration saying the same thing over and over. Only the step still
  // running gets a glyph, and a failure is carried by the row's colour.
  const render = js.slice(js.indexOf('function renderToolRow(row, tool, phase = "live")'));
  const body = render.slice(0, render.indexOf("\n  function "));
  assert.doesNotMatch(body, /✓|✗|"·"/, "steps carry no marks of their own");
  assert.match(body, /icon\.textContent = ""/);
  assert.match(body, /if \(!done && !failed && live\) icon\.classList\.add\("spinning"\)/);
  assert.match(css, /\.tool\[data-status="failed"\] \{[^}]*errorForeground/);
  // The slot keeps its width, or a row jumps sideways as its step finishes.
  assert.match(css, /^\.tool-icon \{[^}]*width: 9px/m);

  const restore = js.slice(js.indexOf("function restoreHistory(saved)"));
  assert.match(
    restore.slice(0, 1100),
    /renderToolRow\(row, tool, "restored"\)/,
    "a chat from last week is not still working"
  );
});

/*
 * VS Code does not hand a webview the editor's TextMate token colours, so an
 * exact match is not on offer. The theme's own colour keys for the same ideas
 * are, and colouring from those follows whatever theme is running rather than
 * hard-coding a palette that fights it.
 */
test("code blocks are coloured from the active theme", () => {
  assert.match(js, /function highlightCode\(code, lang\)/);
  assert.match(js, /highlightCode\(\s*\n?\s*code\.replace/, "the renderer has to use it");
  for (const token of ["comment", "string", "number", "const", "keyword", "fn"]) {
    assert.match(css, new RegExp(`^\\.tok-${token} \\{`, "m"), `.tok-${token} needs a colour`);
  }
  // Every colour comes from the theme, with a fallback only for a theme that
  // leaves the key undefined.
  const tokens = css.slice(css.indexOf(".tok-comment {"), css.indexOf(".tools {"));
  for (const line of tokens.split("\n")) {
    if (!/^\s*color:/.test(line)) continue;
    assert.match(line, /var\(--vscode-/, `a hard-coded token colour would fight the theme: ${line}`);
  }

  // The bare fallbacks are dark-theme values and would be unreadable on a
  // light one, so a light theme gets its own set.
  assert.match(css, /body\.vscode-light \.tok-string/);
  assert.match(css, /body\.vscode-light \.tok-keyword/);

  // `//` is floor division in Python and `#` is a colour in CSS, so the
  // comment style must follow the language rather than trying to be both.
  assert.match(js, /HASH_COMMENT_LANGS/);

  // Everything still goes through escapeHtml, or a reply could inject markup.
  const highlight = js.slice(js.indexOf("function highlightCode(code, lang)"));
  const fn = highlight.slice(0, highlight.indexOf("\n  function renderMarkdown"));
  assert.doesNotMatch(
    fn,
    /\$\{match\[0\]\}|\$\{code\.slice/,
    "raw source must never reach the output unescaped"
  );
  assert.match(fn, /escapeHtml\(code\.slice\(last, match\.index\)\)/);
  assert.match(fn, /const text = escapeHtml\(match\[0\]\)/);
});

/*
 * Both turns were plain full-width prose separated by a 10px label, and the
 * question was painted in the *muted* colour — so the user's own words were
 * the faintest thing on screen, and scrolling back gave the eye nothing to
 * catch on.
 */
test("your own message is a block, at full contrast", () => {
  const user = css.slice(css.indexOf(".msg.user {"));
  const rule = user.slice(0, user.indexOf("}"));
  assert.doesNotMatch(
    rule,
    /color: var\(--vscode-descriptionForeground\)/,
    "the question must not be dimmer than the answer"
  );
  assert.match(rule, /background:/, "it needs a surface to read as a block");

  /*
   * And sized to what was typed, pushed to the right. Stretched to the full
   * width a one-line question read as another paragraph of the conversation
   * rather than as the thing that started it.
   */
  assert.match(rule, /align-self: flex-end/);
  assert.match(rule, /width: fit-content/);
  // Never the whole width: a bubble reaching both margins is a paragraph
  // again, and the strip of ground down its left is what says who sent it.
  const max = rule.match(/max-width: (\d+)%/);
  assert.ok(max, "the bubble needs a maximum width");
  assert.ok(
    Number(max[1]) >= 70 && Number(max[1]) < 100,
    `expected most of the width but not all of it, got ${max[1]}%`
  );

  // A new exchange gets more air than the gap inside one.
  assert.match(css, /\.msg\.user:not\(:first-child\) \{[^}]*margin-top:/);

  const add = js.slice(js.indexOf("function addUserBubble(message)"));
  assert.doesNotMatch(
    add.slice(0, 500),
    /roleLabel\("You"\)/,
    "the block says whose turn it is, so the label is a wasted line"
  );
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

/*
 * The question is a bubble on the right; the answer is prose down the left.
 *
 * This reverses an earlier decision. Both roles ran the full width for a
 * while, on the reasoning that one reading axis suits a narrow sidebar — but
 * that made a one-line question read as just another paragraph, with only a
 * 10px label to say it was the thing that started the exchange. Sized to its
 * own text and set against the answer's alignment, it is findable at a glance
 * when scrolling back. `max-width: 100%` keeps a long question from becoming
 * a narrow column of wrapped text.
 */
test("the question is a bubble, the answer is a column", () => {
  const userRule = css.match(/^\.msg\.user \{[^}]*\}/m);
  assert.ok(userRule, ".msg.user should still be styled");
  assert.match(userRule[0], /align-self: flex-end/);
  assert.match(userRule[0], /width: fit-content/);

  // The answer keeps the full width: long prose in a narrow column wants it.
  const agentRule = css.match(/^\.msg\.agent \{[^}]*\}/m);
  assert.ok(agentRule);
  assert.doesNotMatch(agentRule[0], /flex-end|fit-content/);
});

/**
 * Kiro's turn has no bubble and no alignment of its own, so the label above it
 * is the only thing naming the author. Losing it makes the transcript
 * unreadable, and nothing else would catch that.
 */
test("Kiro's messages say who wrote them", () => {
  assert.match(js, /msg-role/, "chat.js should label each message with its author");
  assert.match(css, /^\.msg-role \{/m, "the role label needs a style");
  assert.match(js, /roleLabel\("Kiro"\)/);
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
  // The method, not a fixed 400 characters of it: a comment added inside was
  // enough to push `preview:` out of the window and fail this for nothing.
  const posted = provider.slice(provider.indexOf("private postAttachments"));
  assert.match(
    posted.slice(0, posted.indexOf("\n  private ")),
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
 * Dragging into the panel is unreliable and always was. VS Code's
 * WebviewElement runs
 *
 *   windowDidDragStart() -> element.style.pointerEvents = "none"
 *
 * for the duration of any drag anywhere in the window, so a plain drag never
 * reaches the panel and nothing inside the webview can change that.
 *
 * The `@kiro` participant used to be the answer, because the native chat box is
 * ordinary workbench DOM. It was removed in 0.24.0 as an undocumented second
 * entry point nobody used, which leaves the routes that do not depend on a drop
 * landing: the attach menu, the Explorer's context-menu command, and paste. At
 * least one of those has to stay reachable, or files cannot be attached at all.
 */
test("files can be attached without relying on a drop", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

  const commands = pkg.contributes.commands.map((c) => c.command);
  assert.ok(
    commands.includes("kiroChat.addFileToContext"),
    "the Explorer command is the route that does not involve dragging at all"
  );
  assert.ok(
    (pkg.contributes.menus["explorer/context"] ?? []).some(
      (item) => item.command === "kiroChat.addFileToContext"
    ),
    "and it has to actually appear in the Explorer's right-click menu"
  );

  for (const action of ["attachFiles", "attachFolders", "attachImage"]) {
    assert.match(
      provider,
      new RegExp(`data-act="${action}"`),
      `the attach menu must still offer ${action}`
    );
  }
});

/** The drop handler stays, since a Shift-drag can still reach the panel. */
test("the panel still listens for a drop even though one may never arrive", () => {
  assert.match(js, /addEventListener\("drop"/, "the drop listener should remain");
  assert.match(js, /addEventListener\("dragover"/, "and the dragover that shows the zone");
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
  // The whole function, not a fixed slice of it: counting inside the first
  // 2600 characters made this fail for a comment being added above the chips.
  const render = js.slice(js.indexOf("function renderChips"));
  const body = render.slice(0, render.indexOf("\n  function "));
  const guards = body.match(/!activeAlreadyAttached/g) ?? [];
  assert.equal(guards.length, 2, "both the live and the muted chip need the guard");
});

/*
 * Dismissing the file chip, then highlighting something in that same file.
 *
 * The selection chip stood in for the file chip whenever a selection was
 * being sent — including when the file had been dismissed and so was not
 * being sent at all. The file chip vanished, its × went with it, and all that
 * was left on screen was a chip whose tooltip read "Kiro gets <file> and the
 * highlighted lines" while no resource_link went out. The panel asserted
 * something it had itself decided not to do, and left no control to undo it.
 */
test("a dismissed file chip does not hide behind the selection chip", () => {
  const render = js.slice(js.indexOf("function renderChips()"));
  const body = render.slice(0, render.indexOf("\n  function "));

  assert.match(
    body,
    /const selectionCoversActiveFile = sendingSelection && includeActiveFile;/,
    "a file that is not going cannot be stood in for"
  );
  assert.match(body, /includeActiveFile = true;/, "and the muted chip adds it back");

  // And the tooltip has to say which of the two situations it is.
  const title = body.slice(body.indexOf("chip.title = includeActiveFile"), body.length);
  assert.ok(title.length > 0, "the selection chip's title must depend on it");
  assert.match(title.slice(0, 500), /and the highlighted lines/, "the file plus the lines");
  assert.match(
    title.slice(0, 500),
    /but not the rest of the file/,
    "or the lines alone, once the file has been dismissed"
  );
});

/*
 * "I add another file to add on the context" only ever held for one message.
 *
 * The row was emptied after every send, so the second message carried
 * strictly less than the first — and because the automatic file chip comes
 * back on its own the row still looked populated, so nothing on screen said
 * the rest had gone. Files and folders stay now. An image does not: its
 * base64 rides in the prompt itself, and a sticky one would re-send megabytes
 * every turn for a picture Kiro has already been shown.
 */
test("attached files outlive the message, and images do not", () => {
  const send = provider.slice(provider.indexOf("async send("));
  const body = send.slice(0, send.indexOf("\n  async sendFromEditor"));
  assert.match(
    body,
    /this\.attachments\s*\r?\n?\s*\.filter\(\(a\) => a\.kind !== "image"\)/,
    "files and folders survive the send; images are consumed by it"
  );
  assert.doesNotMatch(
    body,
    /this\.attachments = \[\];/,
    "which means the row is no longer emptied wholesale after a turn"
  );
  // Starting a different conversation is the other matter entirely.
  assert.match(provider, /this\.attachments = \[\];/, "a new chat still clears it");
});

/*
 * With chips left on the row, Enter on an empty box would have started a real
 * turn out of things already sent — credits spent on a message nobody wrote.
 * "Look at these" with no words is a genuine message, but only the once, so
 * what the guard asks is whether anything on the row is new.
 */
test("a blank composer cannot re-send chips that already went", () => {
  assert.match(provider, /carried: true/, "the provider marks what it has already sent");
  assert.match(provider, /carried: a\.carried === true/, "and passes the mark down");
  assert.match(
    js,
    /const somethingNew = attachments\.some\(\(a\) => !a\.carried\);/,
    "and the composer asks whether anything is new before sending nothing"
  );
  assert.match(js, /if \(!text && !somethingNew\) return;/);
  assert.match(
    provider,
    /if \(!trimmed && !this\.attachments\.some\(\(a\) => a\.carried !== true\)\) return;/,
    "the provider applies the same rule, for the paths that skip the webview"
  );
});

/*
 * Attachments outlive the message they were sent with, so the row needs a way
 * to be emptied. `clearAttachments` sat in the provider's switch for a long
 * time with nothing posting it — the dead half of a contract. Both halves, as
 * ever, or the control does nothing and says nothing about it.
 */
test("the chip row can be cleared, and both halves of that exist", () => {
  assert.match(js, /chips-clear/, "the control needs its class");
  assert.match(
    js,
    /vscode\.postMessage\(\{ type: "clearAttachments" \}\)/,
    "the webview has to post it"
  );
  assert.match(provider, /case "clearAttachments":/, "and the provider has to handle it");
  // A single chip already has an × beside it, so a second control for the
  // same job is noise. The row only offers this past one.
  const render = js.slice(js.indexOf("function renderChips()"));
  const body = render.slice(0, render.indexOf("\n  function "));
  assert.match(body, /if \(attachments\.length > 1\)/, "only worth it past one chip");
});

/*
 * The `background: none` test above catches only the fully plain buttons.
 * `.chip-muted` sets `background: transparent` and keeps a dashed border, so
 * it slipped straight through and painted solid primary blue under the
 * pointer — a fourth instance of a bug that has now shipped four times. The
 * rule is about the global `button:hover`, not about any particular way of
 * spelling "no background of my own", so ask it the right way round: every
 * element this file builds as a <button> that restyles its background has to
 * restyle its hover too.
 */
test("every button that restyles its background restyles its hover", () => {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^}]*)\}/g)];
  const hovered = new Set();
  const restyled = new Set();
  for (const [, rawSelector, declarations] of rules) {
    for (const selector of rawSelector.split(",").map((s) => s.trim())) {
      // A hover rule need not be bare `.name:hover` — `.permission-option`
      // guards its own with `:hover:not(:disabled)`, and that counts. What
      // does not count is a descendant rule, which styles something else, so
      // the class and the `:hover` have to sit in one compound selector.
      const hover = /^\.([\w-]+)[^\s,]*:hover/.exec(selector);
      if (hover) hovered.add(hover[1]);
      const plain = /^\.([\w-]+)$/.exec(selector);
      if (plain && /(^|[;\s])background(-color)?:/.test(declarations)) {
        restyled.add(plain[1]);
      }
    }
  }

  const missing = [];
  let found = 0;
  for (const [, list] of js.matchAll(
    /createElement\("button"\)[\s\S]{0,400}?\.className = "([^"]+)"/g
  )) {
    found += 1;
    const names = list.split(/\s+/).filter(Boolean);
    // Any one of the element's classes carrying a :hover is enough — the
    // question is what the element does, not what each class does alone.
    if (names.some((n) => restyled.has(n)) && !names.some((n) => hovered.has(n))) {
      missing.push(list);
    }
  }
  assert.ok(found >= 4, `expected several built buttons, found ${found}`);
  assert.deepEqual(
    missing,
    [],
    `these paint solid blue on hover, nothing outranking button:hover: ${missing.join(" | ")}`
  );
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

/*
 * The CSP nonce has to be unpredictable, because that is its entire job.
 *
 * It was built from Math.random(), which is seeded per process and recoverable
 * from a handful of samples — so the one value standing between the page and an
 * injected <script> was guessable. The page is otherwise locked down
 * (default-src 'none', no inline handlers), and this closes the gap rather than
 * relying on that.
 */
test("the CSP nonce comes from a cryptographic source", () => {
  const body = provider.slice(provider.indexOf("function nonce("));
  const head = body.slice(0, 400);
  assert.match(head, /randomBytes\(/, "the nonce should be generated with crypto.randomBytes");
  assert.doesNotMatch(head, /Math\.random/, "Math.random is not unpredictable");
  assert.match(
    provider,
    /from "node:crypto"/,
    "randomBytes has to actually be imported"
  );
});

/** A nonce short enough to guess is no better than a predictable one. */
test("the nonce carries enough entropy to be worth having", () => {
  const body = provider.slice(provider.indexOf("function nonce("), provider.indexOf("function nonce(") + 400);
  const bytes = body.match(/randomBytes\((\d+)\)/);
  assert.ok(bytes, "the byte count should be explicit");
  assert.ok(
    Number(bytes[1]) >= 16,
    `${bytes[1]} bytes is too few for a nonce; 16 is the usual floor`
  );
});
