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

`src/usage.ts`, `src/setupWatcher.ts`, `src/startupError.ts`, `src/history.ts` and the `needsShell`/`quote` exports of `src/acpClient.ts` have no `vscode` import so the tests can `require("../out/...")` directly. There is no VS Code test harness in this repo — that constraint is the entire testing strategy. Keep new parsing and logic modules importable without `vscode`.

`setupWatcher.ts` additionally takes its timers through an injected `Scheduler`, so `test/setupWatcher.test.js` drives the whole state machine without waiting out a real interval. Follow that pattern for anything else that polls.

`usage.ts` is deliberately defensive and **never invents a number**: a multiplier is only read as a credit rate when it sits next to the word "credit", and prose parsing only considers lines that mention credits. Preserve that when touching it.

## Webview constraints

**The webview tests are static analysis.** `test/webview.test.js` reads `media/chat.css`, `media/chat.js` and `src/chatViewProvider.ts` as *text* and asserts invariants with regex. Editing markup or CSS can therefore break tests in non-obvious ways. Current invariants:

- `[hidden] { display: none !important }` must sit **above** the component rules in `chat.css`. Author `display` rules outrank the browser's own `[hidden]`, so without the override the attach menu, drop overlay, usage strip and chip row are painted permanently. Four elements are toggled this way: `#chips`, `#usage-bar`, `#dropzone`, `#attach-menu`.
- `.dropzone`, `.chips`, `.usage-bar`, `.popup`, `.usage-panel` each get exactly one rule block.
- `.usage-bar` is a `<button>` (it toggles the account panel) and must keep opting out of the global `button` styling, or the whole strip paints in the primary colour.
- Menus are anchored inside positioned parents (`.attach-wrap`, `.composer`) so they can't spill out of a narrow sidebar.

**CSP is nonce-based** (`script-src 'nonce-...'`), so there are no inline handlers in the HTML — everything is wired up in `chat.js`. Text from Kiro goes through `escapeHtml` before the small hand-rolled markdown renderer runs, so a reply cannot inject markup.

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
