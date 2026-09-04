# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Bumping the version means writing a `CHANGELOG.md` entry.** `announceUpgrade` in `lifecycle.ts` offers "See what changed" and opens that file, so a version shipped without an entry points the user at a changelog that doesn't mention what they just installed. `test/changelog.test.js` enforces it.

```bash
npm test          # compiles first, then runs node --test over test/*.test.js
npm run compile   # tsc -p ./  → out/
npm run watch     # tsc -watch
npm run package   # writes kiro-chat.vsix via @vscode/vsce
npm run build     # install + compile + package
```

Running a single test — note the tests require **compiled** output, so compile first if `src/` changed:

```bash
npm run compile && node --test test/usage.test.js
```

Filter by test name across all files:

```bash
npm run compile && node --test --test-name-pattern="credit rate" "test/*.test.js"
```

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm test`, `npm run package` on `windows-latest` and uploads the `.vsix` as a run artifact. It publishes nothing — this extension is installed from the `.vsix`, never from the Marketplace.

## Architecture

Three processes, two hops:

```
webview (media/chat.js)  ⇄  extension host (src/)  ⇄  kiro-cli acp (child process)
       postMessage                    JSON-RPC 2.0, one object per line over stdio
```

**`src/acpClient.ts`** — a minimal JSON-RPC client over the child's stdin/stdout. The key thing: ACP is **bidirectional**. Kiro sends us requests too, so `AcpClient` has both `pending` (our outbound calls) and `onRequest` (Kiro calling in).

**`src/kiroSession.ts`** — owns the ACP conversation and all Kiro-specific protocol knowledge. Translates JSON-RPC into the `SessionEvents` callback interface.

**`src/chatViewProvider.ts`** — owns the webview. Holds the HTML inline in `html()`, and translates `SessionEvents` into `postMessage` calls.

**`media/chat.js`** — the webview. No framework, no build step; it is shipped as-is.

### The two switch statements are the contract

A feature almost always means editing both:

- `resolveWebviewView`'s `onDidReceiveMessage` switch (`chatViewProvider.ts`) — webview → extension
- the `window.addEventListener("message")` switch (`chat.js`) — extension → webview

`ChatViewProvider.post()` is the only path in the outbound direction.

### Kiro calls back into us

`KiroSession.handleRequest` answers `fs/read_text_file`, `fs/write_text_file` and `session/request_permission`. **Every file path goes through `resolveInsideWorkspace`**, which accepts every root in a multi-root workspace and rejects anything outside all open folders. That function is the security boundary — don't route file access around it. Writes additionally check `kiroChat.allowFileWrites`.

**Containment is tested on real paths, not written ones.** `resolveInsideWorkspace` defers
to `isInsideAnyRoot` in `workspacePaths.ts` (free of `vscode`, so `test/workspaceBoundary.test.js`
drives it against real junctions). Comparing the resolved string defeats `../`, but a symlink
or a Windows junction *inside* the workspace pointing out of it resolves to an in-workspace
string and used to be accepted — which is not what the README promises. Both sides are put
through `realPathOf`, which handles a file that does not exist yet by resolving the nearest
existing ancestor and rejoining the rest; resolving only the child would make every file
under a symlinked workspace root look external. The path handed back is still the one that
was asked for, so a link keeps working as a link once it has been shown to lead somewhere
allowed.

**`allowFileWrites: false` and Plan mode revert; they do not prevent.** Kiro CLI 2.21 makes
its own edits, so there is no call to refuse — the file really is written and then restored
from its pre-turn snapshot. Anything watching the filesystem sees the intermediate state.
Say so plainly in any wording about read-only; the setting's description used to promise
prevention.

With `kiroChat.reviewFileWrites` enabled, `ChangeReviewer` holds the write request open and
opens a read-only virtual source document in the editor. Theme-aware decorations mark pending
deletions red and insertions green. A CodeLens provider supplies whole-file
**Accept all** / **Reject all** and per-hunk **Accept** / **Reject**.

**Do not swap these for inlay hints.** A hint label part carrying a `command` is painted as
a chip and looks far more like a button, but it is only reachable through VS Code's
`ClickLinkGesture`, which fires solely while the trigger modifier is held — a plain click
does nothing at all. That was tried in 0.10.2 and shipped broken. A CodeLens cannot be
styled in any way, but it responds to an ordinary click, and that is the whole trade
VS Code offers here. Accepted hunks write through immediately via `createReviewApplier`;
the virtual document then collapses that hunk to its accepted side and clears its decorations.
Reviews are serialised. **Closing the tab keeps hunks you already accepted** and rejects
only the undecided ones — an accepted hunk was written the moment it was clicked, so
rewriting the pre-turn contents over the file would silently undo agreed work. Cancelling
the turn is the other case and really does drop everything, because the whole run is being
abandoned. That is the `keepDecided` argument to `rejectAll`. `lineDiff.ts` remains independent of VS Code and combines
the accepted hunks.

**Hunk decisions are queued, never dropped.** `decideHunk` chains onto a `decisions`
promise. It used to bail out whenever `applying` was set, so a second click arriving during
the disk write of the first was discarded with nothing on screen to say so — the count
stopped falling, the button looked dead, and because the final decision never landed the
review could never settle. Clicking two hunks in a row is the normal way to use this.

Three details in `ChangeReviewer` that are expensive to rediscover:

- **Review hunks are deliberately finer than display hunks.** `open()` calls
  `buildReviewDiff(before, after, 0)` — context `0`. The span test is
  `index - previous.end > context * 2 + 1`, so with zero context a single unchanged
  line between two edits splits them into separate decisions. The default of `3` would
  merge anything less than seven lines apart into one accept/reject, which is what 0.9.1
  fixed. Tests that call `buildReviewDiff` without the third argument are exercising the
  display default, not what review uses.
- **Serialisation is a promise queue plus a generation counter.** `review()` chains onto
  `this.queue`, and each queued task re-checks `generation === this.generation` before
  opening, so `cancelPending()` (which bumps the generation) drops work that has not
  started as well as rejecting the one on screen.
- **The keybindings are gated on a context key the reviewer sets itself.**
  `Alt+Enter` / `Shift+Alt+Enter` (decide) and `Alt+F5` / `Shift+Alt+F5` (jump) are
  `when`-clause'd on `kiroChat.hunkReviewActive`, which `open()` and `finish()` toggle
  via `setContext`. Forgetting to clear it leaves the shortcuts live over an unrelated
  editor.
- **Jumping walks `rendered.hunks`, not `diff.hunks`.** A decided hunk has already
  collapsed out of the rendered map, so `gotoChange` only ever visits changes that still
  need an answer and the walk empties as the review is worked through. It positions from
  the cursor — stepping out of the hunk it is inside, or to the nearest one in that
  direction — so it stays sane after the user has scrolled. `gotoNext` is also reachable
  from the chat bar (`gotoChange` → `KiroSession.gotoNextChange`), because the diff is
  usually behind the chat and a `when`-gated keybinding cannot be reached from there.

**Accepted content is written through `vscode.workspace.applyEdit`, not `fs.writeFile`.**
`writeThroughEditor` (with `writeFileContent` falling back to disk) exists so Ctrl+Z works
on a change the user accepted: a raw disk write is invisible to the editor, the document
reloads with no undo entry, and the change is permanent. Two consequences that are easy
to get wrong:

- **`restoreSnapshot` deliberately stays on `fs`.** Putting a file back is not an edit the
  user made and must be exact; going through the editor would save it, and saving runs
  format-on-save, so *rejecting* a change could leave the file reformatted. For accepted
  content the formatter is welcome — that is what saving the same edit by hand does.
- **The applier records what landed, not what it asked for.** `createReviewApplier` takes
  an optional `AppliedState` and re-reads the file after writing, because a save
  participant can change the bytes on the way through. Recording the request instead makes
  the next hunk look like an outside edit: every decision after the first is refused and
  the review never settles. Both post-review guards accept `landed` as a final state
  alongside `decision.content` for the same reason.

The review document's tab is named `<filename> (Working Tree)`, following git rather than
inventing a convention — a tab labelled exactly like the real file sits beside it and
invites editing the wrong one. VS Code takes the tab title from the URI's basename, so the
marker has to live there, and there is no public API to label a plain editor otherwise
(`_workbench.open` takes a label but is internal; `vscode.diff`'s title argument only
applies to a diff editor, which this is not).

**That name costs the syntax highlighting, and `applyLanguage` buys it back.** A basename
not ending in the extension matches no language, so the review would render as plain text.
`applyLanguage` reads `languageId` off the real file and calls
`vscode.languages.setTextDocumentLanguage`. Two traps in that call:

- **It recreates the document, firing `onDidCloseTextDocument` for the old one** — the same
  event the user closing the tab fires, which the reviewer treats as an answer. So it runs
  *before* `this.active = review`, and the close handler sees no active review. Moving it
  after would make every review reject itself the instant it opened.
- **Setting `active` later opens a cancellation window**, so `open()` captures the
  generation up front and re-checks it after assigning `active`; a `cancelPending()` that
  arrived while the document was opening had nothing to cancel at the time.

An edit gets **one** gate, not two. `askPermission` recognises a write-like tool
through `isWriteLikeTool` (`writeTools.ts`, shared with `observeDirectFileWrite` so the
two cannot drift) and lets it through without a prompt whenever the review diff is
actually going to open — that is, `reviewFileWrites` and `allowFileWrites` are on and the
turn is not read-only. Asking "may I write this file?" before there is a diff to look at,
and then asking "keep these changes?", is the same question twice and the first one is
unanswerable. When no review will open, that prompt is the only gate there is, so it stays.

The keep-or-undo control is `#change-bar`, pinned between the transcript and the composer
rather than appended to the transcript. It appears the moment `ChangeReviewer` fires
`onDidChangeActiveReview`, so both routes are open at once: decide each hunk in the diff, or
take the whole file from the bar. In the transcript it would scroll away exactly when it is
needed, and it has to stay put while the diff is being read in another tab. While a review is
open the buttons call `acceptActive` / `rejectActive`; once it has settled they fall back
to the turn-level undo below. Keep and Reject disable themselves on click because their
decisions are consumed.

**While a review is open the summary line is itself the jump control** — a `<button>`
rather than a `<div>`, clicked the way a merge conflict is walked: once to reach a change,
again for the next. It therefore has to opt out of the global `button` styling exactly as
`.usage-bar` does, or the whole line paints as a solid primary block. A separate "Next
change" button was tried and removed in 0.12.1: it was a third control competing with the
two decisions beside it.

**Both halves of the bar have to exist, and only a test says so.** The webview half was
lost from `chat.js` once and nothing failed loudly — the provider went on posting
`reviewActive`, `turnChanges` and `changesUndone` into a `switch` with no cases for them,
so no card ever appeared and an edit could only be answered by hunting down the diff tab.
A posted message with no matching case is silent. `test/webview.test.js` now asserts every
one of those three types is both posted and handled.

**The one-gate rule applies at this end too.** `reportTurnChanges` skips every path in
`answeredPaths` — the files whose review the user actually worked through. They gave a
finer answer, hunk by hunk, than the card can take, and a card offering to undo what they
just accepted cannot be answered without contradicting them. A change that never opened a
review is still reported, because there the card is the only gate. Both review routes
(the ACP `fs/write_text_file` callback and the direct-write path) add to the set, so
neither can drift from the other.

After a turn, `reportTurnChanges` compares every pre-turn snapshot in `turnBaselines`
against what is on disk now and posts a **keep or undo** card into the chat. It compares
rather than trusting what Kiro said it would do: a rejected review restores the original and
Kiro sometimes rewrites a file with what it already held, and offering to undo either would
be offering to undo nothing. The snapshots for the files that really changed survive in
`lastTurnBaselines` so `undoLastTurn()` can put them back; `keepLastTurn()` drops them.
`turnChanges.ts` holds the comparison and is free of `vscode`.

`session/request_permission` belongs in the chat webview. `KiroSession.askPermission`
passes Kiro's option ids and labels through `SessionEvents.onPermission`; the provider
posts an inline permission card and resolves the request when `chat.js` returns a
`permissionDecision`. The VS Code notification is only a fallback when no panel exists.

**Neither is `isWriteLikeTool`, and for the same reason.** It used to gate the pre-turn
snapshot in `observeToolPaths` (called `observeDirectFileWrite` until 0.25.0, when it
stopped being only about writes). A tool shape it did not recognise meant no baseline, so
no review and no keep-or-undo card — the edit just appeared on disk. Every path any tool
mentions is snapshotted now, and `finishDirectFileReviews` walks `toolTouchedPaths` and
reviews whatever differs from its baseline; the heuristic only decides whether to
*simulate* a result. `pathsMentionedBy` reads `locations`, `rawInput.path` and
`rawInput.operations[].path`, because Kiro uses all three and only the middle one was
being read.

**A snapshot and a review are not the same entitlement.** Every mentioned path is
snapshotted; only a path from a tool that *might* have written joins `toolTouchedPaths` and
so earns a diff. `isReadOnlyTool` (`writeTools.ts`, beside its counterpart) returns false for
anything it does not recognise — an unknown tool is assumed to have written, which is what
keeps the paragraph above true. Only `read`/`search`/`grep`/`glob`/`list`/`fetch`/`think` opt
out, and their changes still reach the keep-or-undo card. Without that split, a file Kiro
merely read opened a diff whenever a watcher or formatter rewrote it mid-turn, and rejecting
it would have clobbered a write Kiro never made.

Baselines taken from prompt attachments are deliberately **not** in `toolTouchedPaths`. A
file gets a snapshot either because a tool touched it or because the user attached it, and
only the first means Kiro was working on it — reviewing the second would offer to undo the
user's own mid-turn edit.

**`DirectFileChange.expected` is a hint, never a gate.** It simulates what a tool input
should produce, chained across every edit to a file in the turn. It used to have to match
the file byte for byte or the review was abandoned — which drifted for ordinary reasons
(several edits to one file, a replace modelled differently) and then skipped the review
*while leaving Kiro's edit on disk*. An unreviewed edit is the one outcome nobody wants.
The review now always compares what is on disk against the pre-turn snapshot; a mismatch is
logged, not acted on.

Kiro CLI 2.21 does not use that callback for its built-in `FileWrite` tool: it writes the
workspace itself. `KiroSession` therefore snapshots attached files at turn start, captures
other paths from edit tool updates, and at the end of the turn restores their baselines
before opening `ChangeReviewer`. The prompt stays busy until those reviews settle. Keep the
callback path and the built-in-tool path covered; different Kiro versions use different
ones.

The extension advertises `terminal: false` in its client capabilities, so Kiro never asks to run shell commands.

### Kiro-specific protocol quirks

These are the things that were expensive to discover; the comments in `kiroSession.ts` cover them at length:

- **Updates arrive under two method names.** `session/update` carries `tool_call`,
  `tool_call_update` and every `agent_message_chunk`; **`_kiro.dev/session/update` carries
  the `tool_call_chunk`**. `isSessionUpdate` strips an optional `_kiro.dev/` / `kiro.dev/`
  prefix and must keep doing so — matching only the bare name rejected every
  `tool_call_chunk` at the door, so the panel had nothing to show for the whole gap before
  a step's real title arrived. `_kiro.dev/metadata` has the same shape and is why both
  spellings were already named there. **Assume any Kiro notification may carry the
  prefix.**
- **A step is announced three times, and the first one matters.** Measured by driving
  `kiro-cli acp` directly: `tool_call_chunk` fires the moment Kiro decides to use a tool
  and carries **only the kind as its title** (literally `"read"`) and no status;
  `tool_call` follows with the real title (`"Reading package.json:1"`), `locations` and
  `rawInput`; `tool_call_update` finally carries `status`. All three share a
  `toolCallId`, so they collapse to one row. Handling only the last two left the panel on
  "Working…" for the whole of the first gap, which is the part of a turn that feels
  longest. `describeTool` translates a title that is nothing but the kind through
  `TOOL_VERBS`, and a real title always wins. `rawInput.__tool_use_purpose` is Kiro's own
  note on *why*, and is the reason the steps list is worth unfolding.
  `test/toolSteps.test.js` pins all of this to the captured payloads.
- **`runCommand`** hits `_kiro.dev/commands/execute` with an adjacently-tagged enum: `{ sessionId, command: { command: "usage", args: {} } }`. A plain string, or a name with a leading `/`, is rejected outright.
- **`textSpy`** — Kiro's own commands narrate through the ordinary `agent_message_chunk` stream. The spy diverts that so command output doesn't land in the transcript as if the user had asked for it.
- **Credit rates need a second call.** The model list returned by `session/new` carries no rate; only the `model` command has `rateMultiplier` and the context window. `enrichModels()` fetches it in the background after connecting.
- **The usage meter arrives two ways** — as a `_kiro.dev/metadata` notification, and sometimes bolted onto an ordinary `session/update`. `handleNotification` reads both; dropping either leaves the usage strip blank for a whole conversation.
- `session/prompt` is sent with the payload under **both** `prompt` and `content`, because Kiro's docs and the ACP spec disagree on the field name.
- The five composer workflows live in `chatModes.ts`. They are explicit prompt instructions,
  rather than claims that Kiro ACP natively exposes all five. Plan additionally passes
  `readOnly` to `KiroSession.send`; callback writes are refused and direct CLI writes are
  restored at the end of the turn.

### What kiro-cli 2.20.2 actually reports

Measured by driving `kiro-cli acp` directly, not read from docs:

```
agentCapabilities: {
  loadSession: true,
  promptCapabilities: { image: true, audio: false, embeddedContext: false },
  mcpCapabilities: { http: true, sse: false },
}
```

- **`loadSession: true`, and session ids survive the CLI process dying.** A session created by one process loads in a fresh one, which is what makes chat history able to resume rather than just replay.
- On load, Kiro sent no conversation replay — only `_kiro.dev/subagent/list_update`. The session under test was empty so that isn't conclusive, which is exactly why the panel redraws from its own stored transcript and `KiroSession.replaying` swallows `session/update` during the load call. If Kiro does replay, you get it once, not twice.
- Kiro also reports three native mode ids (`kiro_default`, `kiro_planner`, `kiro_guide`).
  They do not map one-to-one to the five composer workflows, so the workflow picker remains
  explicit and deterministic instead of presenting incompatible ids as the same feature.

## Chat history

Records live in `context.globalState` under `kiroChat.history`. The transcript itself is maintained by the **webview** (it already did, for surviving panel moves) and posted up as a `transcript` message after each turn — one source of truth rather than accumulating chunks in the extension host too.

Chats are filtered to the open folder, because Kiro binds a session to its `cwd` and a chat from another project cannot meaningfully resume. `forWorkspace` normalises Windows path spellings; comparing raw strings would silently hide the user's own chats.

A chat whose `session/load` fails still shows its transcript, but the composer locks — replying would otherwise start a *different* conversation without saying so.

**A transcript the extension handed down must not be reported back.** `saveState(false)`
in the webview's `openChat` case exists for that. `openChat` posts the stored transcript
and *then* awaits `session/load`; the webview's report beats a 30-second ACP request every
time, so reporting it re-saved the record mid-load — stamping it with `updatedAt: now` (a
chat jumped to Today for being read) and with `session.currentSessionId`, which was still
the *previous* chat's. Reopening it after that resumed the wrong conversation. The
provider guards the same thing from its end: `chatSessionId` is pinned from the record
before the post, and `saveCurrentChat` prefers it over the live session.

**Three paths begin a chat and all three go through `beginFreshChat()`** — the `+` button,
`retry` on the setup screen, and `onWebviewReady` with a blank panel. It archives the
outgoing chat, rotates `chatId`, and clears the transcript. The last two used to do none
of that, so the next conversation was written into the previous chat's record and
`upsertRecord` replaced it; the old chat vanished with no delete. `test/webview.test.js`
asserts all three call it.

**Titles are sticky (`stableTitle`).** Only the last `MAX_HISTORY` messages are stored, so
re-deriving the name from the saved transcript renamed a long chat the moment its opening
message fell out of the window. Only the `New chat` placeholder may be replaced. Where the
tail is all that survives, `truncated` rides along and the panel says so rather than
appearing to begin mid-conversation.

**Only the pending chat is held in memory, never the list.** `saveCurrentChat` runs per
message and each write serialises every stored transcript, so writes are debounced through
`pendingChat` + `scheduleFlush`. `flushChats` re-reads the list with `allChats()` at write
time on purpose: caching it would let a second VS Code window's saves be overwritten by
this one's stale copy. Anything that must not lose a save — `dispose`, `deleteChat`,
`openChat`, `postHistory`, `beginFreshChat` — calls `flushChats()` first.

`pruneHistory` caps chats **per folder**, because the list only ever shows one folder's;
a global cap let a busy project evict a quiet one's history.

## Images

`postAttachments` sends a `data:` URI as `preview` for image attachments; the page's CSP already allows `data:` for `img-src`. It previously stripped `data` entirely, which is why images showed as filenames. Over `MAX_PREVIEW_BYTES` no preview is sent and the chip falls back to text — the thumbnail is rendered ~22px wide and is not worth pushing megabytes through `postMessage` for.

### Modules kept free of `vscode` on purpose

`src/usage.ts`, `src/setupWatcher.ts`, `src/startupError.ts`, `src/history.ts`, `src/promptBlocks.ts` and the `needsShell`/`quote` exports of `src/acpClient.ts` have no `vscode` import so the tests can `require("../out/...")` directly. There is no VS Code test harness in this repo — that constraint is the entire testing strategy. Keep new parsing and logic modules importable without `vscode`.

`setupWatcher.ts` additionally takes its timers through an injected `Scheduler`, so `test/setupWatcher.test.js` drives the whole state machine without waiting out a real interval. Follow that pattern for anything else that polls.

**The file/selection duplication has to be fixed in three places, and they are not
independent.** `buildBlocks` (what Kiro receives), `renderChips` (the row above the box)
and `addUserBubble` (the tags under a sent message) each build that list separately, so
fixing one leaves another showing `media/chat.js` beside `media/chat.js:23-27`. The rule
is *one mention per file, narrowest wins*: a file the selection block already names is
not also listed above it. The two webview lists name files with `fileName()`, keeping the
path in the tooltip.

Two asymmetries in that rule are deliberate:

- **Only the automatic file may be stood in for on screen.** `renderChips` suppresses the
  `◎` chip, never an attachment chip: a chip is a control, and removing one because of a
  transient highlight takes away the × that removes the file. `addUserBubble` reads
  `source === "active"` for the same reason — a file attached by hand is still sent as its
  own `resource_link`, so hiding its tag would leave no record in the transcript that it
  went.
- **`buildBlocks` drops the *text* mention, never the link.** The resource_link is how Kiro
  opens the file; the list entry only makes the path visible. The entry is what duplicated,
  so the entry is what goes.

**Three sources feed one message, and `source` is what tells them apart.**
`attachmentsForMessage` appends the focused file to whatever was attached by hand, dropping
it when the same file is already there (`samePath`, so Windows spellings match). The
automatic one carries `source: "active"`, which is what stops `buildBlocks` listing the
tab that merely happens to be focused under "Files to look at" beside files the user chose
— "update these files" quietly took in the focused one. With `kiroChat.sendSelection` off
it gets its own line instead, saying what it is.

**Attachments outlive the message; images do not.** The row used to be emptied after every
send, so "add another file to the context" held for exactly one message — and because the
`◎` chip comes back on its own, the row still looked populated while the rest had silently
gone. Files and folders now stay until removed. An image is consumed, because its base64
rides in the prompt itself and a sticky one re-sends megabytes per turn for a picture Kiro
has already seen. What survives is marked `carried`, which is what stops Enter on an empty
composer starting a whole turn out of chips that already went; attaching something new
clears the mark, because "look at these" with no words is a real message — once.

**A chip may only stand in for something that is actually going.** `sendingSelection` (are
the highlighted lines going?) and `selectionCoversActiveFile` (may the selection chip stand
in for the file chip?) are two questions, and collapsing them into one shipped a lie:
dismiss the `◎` chip with its ×, then highlight something in that same file, and the file
chip vanished behind a selection chip whose tooltip promised Kiro was getting the file
while no `resource_link` went out — with the × that would have said otherwise now off
screen. The second condition therefore ANDs in `includeActiveFile`, and the selection
chip's tooltip branches on it too.

**The selection chip reports state; it is not a control.** It carried an × that stopped
the highlighted code being sent, which left the editor showing a selection the panel had
decided not to send — and no way to tell from either side which was true. Clearing the
highlight is the only way to stop it, so `includeSelection` is now driven solely by the
`kiroChat.sendSelection` setting and nothing in the webview writes to it. The chip also
shows only the basename (`fileName()`); the full path stays in the tooltip and in what is
sent to Kiro.

`promptBlocks.ts` holds the last handling of the user's own text before it leaves, so it
takes its URI maker as an argument rather than importing `vscode`. Three rules there each
fixed a way Kiro was told something untrue, and all three are load-bearing:

- **`canReadSelectionFrom` is a scheme allow-list, not a deny-list.** It used to exclude
  only `output`, so the change-review tab (`kiro-change-review:/<id>/chat.js (Working
  Tree)`) counted as the file being looked at — clicking in a diff, which is how its
  keybindings are used, then made the next message claim a path that exists nowhere. Git's
  sides and search editors are the same shape of mistake.
- **`fenceFor` beats the longest backtick run in the selection.** A fixed ``` fence is
  ended by the first such line inside the code, so a markdown file or a template literal
  spilled the rest of the message out of the block and Kiro read the user's code as prose.
- **`clipSelection` reports that it clipped**, and `buildBlocks` says so beside the line
  range. Naming lines 26–480 over the first 12k characters claims Kiro has all of it.

`usage.ts` is deliberately defensive and **never invents a number**: a multiplier is only read as a credit rate when it sits next to the word "credit", and prose parsing only considers lines that mention credits. Preserve that when touching it.

## Webview constraints

**The webview tests are static analysis.** `test/webview.test.js` reads `media/chat.css`, `media/chat.js` and `src/chatViewProvider.ts` as *text* and asserts invariants with regex. Editing markup or CSS can therefore break tests in non-obvious ways. Current invariants:

- `[hidden] { display: none !important }` must sit **above** the component rules in `chat.css`. Author `display` rules outrank the browser's own `[hidden]`, so without the override the attach menu, drop overlay, usage strip and chip row are painted permanently. Four elements are toggled this way: `#chips`, `#usage-bar`, `#dropzone`, `#attach-menu`.
- `.dropzone`, `.chips`, `.usage-bar`, `.popup`, `.usage-panel` each get exactly one rule block.
- `.usage-bar` is a `<button>` (it toggles the account panel) and must keep opting out of the global `button` styling, or the whole strip paints in the primary colour.
- **`.composer-row` sets `--control-h` and every control in it takes that height.** They used to be sized three different ways and none of them lined up. Anything added to that row takes `--control-h` too. `.icon` also joined the `[hidden]` list above when Stop became an icon button: it is toggled with the `hidden` attribute and carries `display: inline-flex`, so it must stay below the `[hidden]` override.
- **A plain-looking button must cancel `button:hover`, not just `button`.** `background: none` on a class beats `button`, but `button:hover` is a type plus a pseudo-class — specificity (0,1,1) — and outranks any single class, so the element sits transparent at rest and then paints solid primary blue under the pointer. This shipped four times (`.usage-bar`, `button.change-summary`, `.history-open`, which covered the row's own hover tint with a blue slab, and `.chip-muted`). One test walks every rule declaring both `background: none` and `border: none` and requires a matching `:hover`.

**That test catches only the spelling, which is how the fourth one got in.** `.chip-muted`
says `background: transparent` and keeps a dashed border, so it matched neither half of
that pair. The question is not how "no background of my own" is spelled — it is whether an
element that VS Code will paint on hover has said otherwise. The second test therefore
reads the `className` off every `document.createElement("button")` in `chat.js` and
requires that, if any of its classes restyles the background, one of them carries a
`:hover`. Per element, not per class: `.chip chip-muted` is covered by `.chip-muted:hover`.
A hover rule need not be bare `.name:hover` either — `.permission-option:hover:not(:disabled)`
counts, and a descendant rule deliberately does not.
- Menus are anchored inside positioned parents (`.attach-wrap`, `.composer`) so they can't spill out of a narrow sidebar.

**CSP is nonce-based** (`script-src 'nonce-...'`), so there are no inline handlers in the HTML — everything is wired up in `chat.js`. Text from Kiro goes through `escapeHtml` before the small hand-rolled markdown renderer runs, so a reply cannot inject markup.

**`renderMarkdown`'s `FENCE` pattern is anchored to a line, and must stay that way.**
Matching ``` anywhere meant a run of backticks *inside a sentence* — "uses longer fences
(````)", a snippet quoted mid-line, any answer about markdown — opened a code block and
swallowed the remainder of the reply into it. The more a reply discussed code, the more
likely it was to be destroyed. Two details that look removable and are not: the closing
fence is anchored too, and the unterminated branch is `(?![\s\S])` rather than `$` —
under the `m` flag `$` means end of *line*, which would cut every block at its first
newline, and a streaming reply is unterminated for as long as it is arriving. Line
endings are normalised to `\n` before any of this runs, because the pattern consumed `\n`
after the language but not `\r\n`, leaving a carriage return that `<pre>` painted as a
blank line above and below every snippet.

**`renderMarkdown` handles GFM pipe tables, and the guard is the load-bearing half.**
Without table support every row fell through to the paragraph branch, so a table arrived
as one `<p>` per row with margins between and `|---|---|` printed as literal dashes —
which is most of any "here is the mapping" reply, and agents write those constantly. What
identifies a table is the **delimiter row**, exactly as GFM says, and its cell count must
match the header's: a line containing a pipe above a line of dashes is otherwise ordinary
prose over a horizontal rule, and turning that into a table is a worse bug than the one
being fixed. Rows shorter than the header are padded rather than dropped, because a
missing cell shifts every column after it. The table is wrapped in `.table-wrap`, which
scrolls on its own — a sidebar is three inches wide, and the alternative is a horizontal
scrollbar on the whole conversation.

**Text that resumes after a tool step starts a new paragraph.** Kiro says something, calls
a tool, then says something else, and all of it is appended to one `buffer` — so the two
ran together with no space at all: "…rather than guessing from names.I notice
RENEWAL_WINDOW_CLOSED…". Nothing in the stream marks where one message ends, but a step
starting is a boundary that can be seen, so `breakBeforeText` is set there and consumed by
the next chunk. It is set only where a tool row is **created**, never on a status update
for a step already listed: those arrive while text is still streaming and would split a
sentence down the middle, which is the same bug pointing the other way.

**`test/webview.test.js` can run the renderer, and should.** `loadRenderer()` slices
`escapeHtml` through `renderMarkdown` — contiguous and self-contained — and evaluates it,
so the table and fence tests assert on rendered HTML rather than on the shape of the
source. Prefer that to a regex whenever the thing under test is a behaviour.

**Do not slice a fixed number of characters out of a function to assert on it.** Four
tests did (`slice(0, 2600)`, `slice(0, 400)` twice, `slice(0, 500)`) and every one of them
failed for a comment being added above the line they wanted — a test that breaks when
nothing broke. Slice to the next `case`, the next `function`, or the end of the block.

**The code-block copy button is delegated, and it must stay that way.** A streaming reply
runs `body.innerHTML = renderMarkdown(buffer)` on every frame, so a listener bound to the
button is discarded several times a second and the control dies mid-reply. One listener
sits on `#messages` and resolves `closest(".code-copy")`. It copies `code.textContent` —
the rendered element — so what reaches the clipboard is exactly what is on screen, with no
second escaping pass to get wrong, and it re-checks `isConnected` before writing its
"copied" state because the button may have been replaced while the clipboard call was in
flight. When both clipboard routes are refused it selects the code and says to press
Ctrl+C; a button that silently does nothing is worse than no button.

**The turn's progress is shown where the answer will be, not on the status line.**
`startThinking()` runs on `userMessage` — not on the first chunk, which is the thing being
waited for — and starts a one-second interval so the header keeps counting *while the
reply streams*; the elapsed number is what separates a slow turn from a stuck one, so only
`finishAgentBubble` stops it. `finishAgentBubble` must also `clearInterval` on the bubble
it discards, or an abandoned timer ticks against a removed node forever.

The agent body must not be created with the `cursor` class, and the chunk handler toggles
it on `buffer.trim()`: a blinking block over an empty bubble claims a reply has started
when an empty first chunk is all that has arrived.

`updateStepsLabel` puts the *newest unfinished* step on that header — "Working…" answers
the wrong question while waiting; what the user wants to know is what it is doing. It runs
from the `tool` case, which also calls `startThinking()` itself, because a tool update can
arrive by a route that never posted a `userMessage`.

**The steps list is open while the turn runs and folds when it ends.** Closed-by-default
hid the one thing the list is for — watching Kiro read and edit — so the `tool` case opens
it and `stopThinking` closes it. `steps.dataset.pinned` records that the user clicked the
header, and both of those checks respect it: a list someone opened on purpose must not
fold itself up when the turn finishes.

**`AcpClient.dispatch` is called inside a try/catch, and must stay that way.** Kiro often
writes several notifications in one stdio write; the read loop walks them in order, so a
throw in any handler used to abandon the loop and drop every remaining line in that write
— silently, and indistinguishably from Kiro never having sent them.

**The steps list folds, so nothing that needs an answer may live in it.**
`addPermissionCard` inserts before `bubble.body`, never into `bubble.tools` — a permission
card inside a closed list cannot be seen or answered, and the turn hangs waiting.
`renderToolRow(row, tool, phase)` is shared by all three paths: `"live"` shows a spinner
and *no* tick on finished steps (a column of them beside running work is noise), `"done"`
adds the ticks once the turn is over, and `"restored"` never spins, because a chat from
last week is not still working.

**Code blocks are coloured from the theme's own colour keys, not the editor's tokens.**
VS Code does not expose TextMate token colours to a webview, so `highlightCode` marks
comments, strings, numbers, keywords and call sites and paints them with
`--vscode-debugTokenExpression-*` / `--vscode-symbolIcon-*`, which are the theme's colours
for the same ideas. The tokenizer stays small on purpose — a wrong colour reads worse than
no colour — and the comment style follows the language (`//` is floor division in Python,
`#` is a colour in CSS). Everything still goes through `escapeHtml` before it reaches the
output; the spans are the only markup added.

**The webview is destroyed and rebuilt** whenever the user drags the panel between the sidebar, the bottom panel and the secondary sidebar. `chat.js` persists the transcript through `vscode.setState`, then posts `ready` with a `restored` flag; `onWebviewReady` branches on it — restored means leave the session alone, blank means hand the user a fresh connected chat. Anything that must survive a move has to live in webview state.

## Windows-only by design

Mac and Linux support was removed deliberately so there is one code path instead of three. `extension.ts` checks `process.platform` at activation and says so plainly rather than failing later.

- `findKiro.ts` searches install folders (starting `%LOCALAPPDATA%\Kiro-Cli\`), then `where kiro-cli`, then WSL.
- `acpClient.ts` routes `.cmd`/`.bat` shims through the shell — since Node 20, spawning one without a shell throws a bare `EINVAL`.
- `lifecycle.ts` clears a pinned `kiroChat.command` when the file no longer exists, since Kiro's own updates move the binary.

## Setup flow

`ChatViewProvider.runInTerminal` opens PowerShell and types the command with `sendText(command, false)` — **no trailing newline, on purpose**. The user presses Enter. Nothing runs behind their back; the README promises this. Don't "fix" it into auto-execution — the automation is in the *detection*, not the execution.

`onNeedsSetup` fires with `"missing"` (no binary found) or `"signin"` (found but the handshake failed) and shows the setup screen. From there `SetupWatcher` drives it: it polls `findKiro()` until the binary appears, then attempts the handshake itself, so the panel becomes a chat without the user clicking anything.

Three things this flow gets wrong easily:

- **`setupActive` in the provider.** Every failed handshake makes `KiroSession` fire `onNeedsSetup` again. Without the guard, each retry rebuilds the setup screen and wipes the progress the watcher just reported.
- **`leaveSetup()` hangs off the `ready` status, not off the watcher.** Pressing Connect, or restarting from the title bar, connects without the watcher saying anything. Dismissing the screen only on the watcher's `connected` strands the user on install instructions with a dead composer while Kiro is up.
- **`setBusy` defers to setup.** A `ready` status arriving mid-setup must not re-enable Send, so `setBusy` ORs in `setup !== null`.
