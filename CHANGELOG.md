# Changelog

## 0.25.1

- **A file Kiro only read no longer opens a review when something else changes it.** 0.25.0
  reviewed any snapshotted file that differed by the end of the turn, which was the right
  question for a file Kiro wrote and the wrong one for a file it merely read: a watcher, a
  formatter or a dev server rewriting one mid-turn opened a diff, and rejecting that diff
  would have clobbered a write Kiro never made.

  The snapshot is still taken either way — it costs one read, and a later unrecognised write
  to the same file needs a "before" that predates it. What a read no longer earns is the
  diff. The change is still reported in the keep-or-undo card, which is the gentler surface
  for "this changed, was that you?"; going quiet about it would be the original bug again.

- **`isReadOnlyTool` answers false for anything it does not recognise**, and that asymmetry
  is the whole design. An unknown tool is assumed to have written, so 0.25.0's fix for
  unreviewed edits is untouched — only a kind that positively cannot write (`read`,
  `search`, `grep`, `glob`, `list`, `fetch`, `think`) opts a file out. `execute`/`shell` are
  deliberately absent: a command can write anything, and `terminal: false` is not a proof.

## 0.25.0

- **An edit made by a tool the extension did not recognise no longer lands unreviewed.**
  `isWriteLikeTool` gated the pre-turn *snapshot*, not just the simulated result — so a tool
  shape it did not know, or a path it could not find, meant no baseline, no diff, no
  keep-or-undo card, and Kiro's edit simply appeared on disk with nothing said about it. An
  unreviewed edit is the one outcome nobody wants, and a heuristic was the only thing
  standing in its way.

  The heuristic is a hint now, the same demotion `DirectFileChange.expected` already went
  through. Every path any tool mentions gets a snapshot, whatever the tool is — reading a
  file is the strongest available signal that an edit is coming — and the end-of-turn pass
  reviews whatever actually differs from its snapshot. "Did this change?" needs no
  heuristic to answer correctly.

- **Paths are read from everywhere Kiro puts them.** Only `rawInput.path` was consulted.
  The payload captured from a real turn carries the path in `locations` *and* in
  `rawInput.operations[].path`, and in neither of the places the extractor looked — so the
  `operations` form, which the built-in edit tools use, was missed every time.

- **A file the user edits mid-turn is deliberately still not swept into a review.** A
  baseline exists for two reasons: a tool mentioned the file, or the user attached it. Only
  the first means Kiro was working on it, and only those are reviewed. A diff offering to
  undo the user's own typing would be worse than the gap it closed.

- Snapshots no longer throw. A directory, an unreadable path or something implausibly large
  comes back as "no baseline" rather than an exception — which, now that far more files are
  snapshotted, would otherwise have taken the whole keep-or-undo card down with it. Files
  over 10MB are skipped and logged.

## 0.24.0

- **The `@kiro` chat participant is gone.** It was a second way into the same Kiro session,
  aimed at VS Code's own chat box, and it was never documented in the README — so the only
  people who found it were the ones who went looking. Its real draw was that a file could
  be dragged onto the native chat box, which a webview can never accept: VS Code sets
  `pointer-events: none` on every webview for the duration of any drag.

  Attaching files is unaffected. The **+** button, **Kiro Chat: Add to Chat Context** in
  the Explorer's right-click menu, and pasting an image all work as before, and none of
  them depend on a drop landing. What goes is the ability to drag a file onto VS Code's
  chat box and have Kiro answer there.

  Removed with it: the `kiroChat.askInChat` command, `src/participant.ts`,
  `src/references.ts`, and the `TurnSink` plumbing in `KiroSession` — `sendTo`, the `sink`
  field, and the branch in every notification handler that asked whether the panel or the
  participant was the audience.

- **Two of 0.23.0's fixes are now moot, which is the better outcome.** The concurrency
  guard and the `turn_end` routing existed because one session had two front doors that
  were not aware of each other. With one door there is no such race to guard against. The
  busy check survives in a simpler form, because **Kiro Chat: Explain Selection** still
  reaches `send` without passing the webview's disabled Send button.

## 0.23.0

- **Asking a second question mid-turn no longer answers it into the wrong window.**
  `sendTo` guarded against a second turn on the session; `send` did not, and it is
  reachable without passing the panel's disabled Send button — **Kiro Chat: Explain
  Selection** goes straight to it. Right-clicking code while `@kiro` was answering in VS
  Code's own chat box put a second `session/prompt` on one session, and because the
  participant still owned the output, the panel's reply was streamed into *its* response
  instead. Both entry points now share one guard, which runs before the sink is claimed.
  A refused message is turned away before its bubble is posted, so the text stays in the
  box rather than vanishing into a transcript.
- **`turn_end` is routed the same way as everything else.** An `@kiro` turn finishing used
  to post a turn-ended message into the panel, which was not running it.
- **A long `@kiro` answer is no longer cut off after two minutes.** The idle timeout was
  armed once and never re-armed, making it a hard cap on the whole turn rather than a
  check for Kiro going quiet — so a multi-file edit was cancelled mid-sentence with
  nothing said about why. Every chunk of text and every tool step now pushes it back.
  Real silence still ends the turn.
- **Restarting the agent no longer leaves Kiro running.** When the CLI is a `.cmd` shim it
  runs through the shell, so the process being killed was `cmd.exe` and `kiro-cli` was its
  grandchild — it survived, still holding its session. Windows has no process group to
  signal, so the whole tree goes through `taskkill` now.
- **The review tab is closed wherever it is.** Pressing **Keep** on the chat bar while
  looking at another file left the `(Working Tree)` tab open and deleted the content behind
  it, so a stale, empty tab stayed until it was closed by hand. The chat bar exists so the
  diff does not have to be in front of you, which made this the ordinary path rather than
  an edge case.
- **The workspace boundary now checks where a path really leads.** It compared paths as
  written, which stops `../` but says nothing about a symlink or a junction *inside* the
  folder pointing out of it: that resolved to an in-workspace string and was allowed. Both
  sides are resolved before the containment test, with a file that does not exist yet
  handled through its nearest existing parent so creating one still works. A link that
  stays inside the workspace is unaffected.
- **Auto-approval takes the narrowest permission on offer.** Kiro sends `allow_once` and
  `allow_always` side by side and the first one won, so `kiroChat.autoApproveTools` could
  hand out a standing grant where a single-use one was available.
- The page's CSP nonce is generated with `crypto.randomBytes` rather than `Math.random`,
  which is seeded per process and recoverable from a few samples.
- Unterminated output from Kiro is capped instead of accumulating without limit. The check
  runs after complete messages have been dispatched, so a large write of real messages is
  never discarded.
- A tool step that arrives without a `toolCallId` keeps one id across its updates instead
  of taking a random one each time, which used to add a row to the steps list per
  notification.
- **The README said several things the code does not do.** Closing a review tab keeps the
  hunks you already accepted rather than rejecting everything; the CodeLens actions are
  **Accept** / **Reject** and not numbered "change N of M"; the sign-in command is
  `kiro-cli login`; images and past chats were still listed as unbuilt in a file with
  sections describing both. `kiroChat.attachActiveFile` was missing from the settings table.
- **`allowFileWrites` and Plan mode are described honestly.** Neither prevents a write:
  Kiro CLI makes its own edits, so the file is written and then restored from its pre-turn
  snapshot. That is invisible in the editor but not to a file watcher, a dev server or a
  build, and the setting used to promise a read-only chat.

## 0.22.2

- **A run of backticks inside a sentence no longer swallows the rest of the reply.** A
  code fence only opens a block at the start of a line — the renderer matched ``` anywhere,
  so a sentence like "uses longer fences (\`\`\`\`)", a shell snippet quoted mid-line, or
  any answer discussing markdown turned everything after it into one enormous code block.
  The more a reply talked about code, the more likely it was to be destroyed. Both the
  opening and closing fence are anchored to a line now.

  The unterminated case uses an end-of-*string* assertion rather than `$`, which under the
  multiline flag means end of line and would cut every block at its first newline — a
  streaming reply is unterminated for as long as it is arriving.

## 0.22.1

- **Windows line endings no longer break code blocks.** The fence pattern consumed the
  `\n` after the language but not `\r\n`, so the carriage return was captured as the first
  character of the code — and `<pre>` renders a lone `\r` as a break. Every snippet in a
  reply with CRLF endings came out with a blank line above and below it, and because the
  culprit was invisible whitespace there was nothing on screen to explain it. Line endings
  are normalised once before anything parses the text, which fixes fences, headings and
  lists together.
- A fence indented under a list no longer leaves its indent as a trailing line inside the
  code, and `` ```js `` followed by a space is recognised.

## 0.22.0

- **Kiro sends its updates under two method names, and one of them was being thrown away.**
  `session/update` carries `tool_call`, `tool_call_update` and every message chunk;
  `_kiro.dev/session/update` carries the `tool_call_chunk` — the first word that a step is
  starting. Only the unprefixed name was accepted, so every one of those was rejected
  before it reached the handler and merely written to the log as an unknown notification.
  That is exactly the window in which the panel has nothing to say but "Working…", and it
  is the longest-feeling part of a turn. Both spellings are accepted now, which is what
  `_kiro.dev/metadata` already did by naming both.

  Found by capturing a whole turn straight off `kiro-cli acp` and comparing the method
  names against what the extension accepts. `test/toolSteps.test.js` pins both spellings.

## 0.21.0

- **The log of what Kiro ran is always there, and folded.** The header is now revealed by
  the step itself rather than as a side effect of the clock starting — which did nothing
  once the clock was already running, so what guaranteed the log was visible was a call
  that had usually already happened. A step can no longer be recorded without somewhere to
  see it. It stays folded: the header names the step being run, and the rest is one click
  away. A list you open yourself stays open.
- **The composer row is compact**: 22px instead of 26, with smaller icons and tighter
  padding. One `:is()` rule hands that height to every control rather than a list naming
  each one — the old version only held the controls it happened to name, so one moved into
  a different wrapper would silently go back to sizing itself. Measured at editor font
  sizes 11, 13 and 16px: attach, workflow, model and send all 22px.

## 0.20.1

- **One shape for the steps header.** A turn that ran no steps had a second version of that
  line — the chevron slot standing empty, because there was nothing to unfold, sitting at a
  different indent from the ordinary one. Neither was wrong on its own; together they read
  as a mistake. That version is gone: a turn with no steps shows no header, so every header
  in the transcript looks the same.
- **Your bubble stops short of the left margin.** At the full width it was a paragraph
  again; the strip of ground down its left is what says somebody sent it. Long questions
  still get almost all the room.
- **The send arrow points straight right** — no tilt, no paper plane.

Also measured while checking the row: every control in it holds 26px at editor font sizes
from 11px to 18px.

## 0.20.0

- **You can watch Kiro work again.** The steps list is open while the turn is running and
  folds itself away when the turn ends — the actions were still being recorded, but behind
  a closed fold, which hid exactly the part that answers "what is it doing". Open or close
  it yourself at any point and that choice sticks for the rest of the turn.
- **Your question is a bubble on the right**, sized to what you typed and growing to the
  full width when it needs it. Both roles ran the full width before, which made a one-line
  question read as another paragraph of the conversation rather than as the thing that
  started the exchange.
- **More air between exchanges** than between a question and its own answer, so a long
  conversation reads as a stack rather than one undifferentiated column.
- **One bad notification no longer costs the rest of its batch.** Kiro often writes several
  notifications in a single stdio write, and a throw in any handler abandoned the loop that
  walks them — every message after it in that write was dropped silently, looking exactly
  like Kiro never having sent it. Each is now handled on its own and a failure is logged.

## 0.19.0

The row under the message box.

- **Everything in it is one height.** The controls were sized three different ways — the
  attach button by fixed pixels, the pickers by their own padding, Send by the global
  button padding — so nothing lined up. One `--control-h` now feeds all four.
- **Send and Stop are icons**: a paper plane and a square, both labelled for screen
  readers and both the same 26px square as the attach button. Send keeps the accent
  colour; it is the only thing in the row that has it.
- **The pickers lead with an icon instead of trailing a chevron.** The chevron said only
  "this opens" — which a click discovers anyway — while costing width in a panel that has
  none to spare, and it made the two pickers read as a pair of form fields rather than
  part of the same row of controls.

## 0.18.1

- **A finished turn reads as one sentence**: `Completed 2 steps in 7s`. While the turn is
  running the two halves stay separate — what it is doing on the left, the clock on the
  right — because those are two different things; once it is over it is a single fact, and
  splitting it left a label with a stray number after it. The "Worked for" wording is gone.
- **The ticks are gone from the step list.** A green ✓ beside every finished row was a
  column of decoration repeating what the header already said. The only step that gets a
  mark now is the one still running, and a failure is carried by the row's own colour.

## 0.18.0

Steps, measured against what kiro-cli 2.20.2 actually sends rather than guessed at.

- **The first notification for a step was being thrown away.** Kiro announces a step three
  times: `tool_call_chunk` the moment it decides to use a tool, then `tool_call` with a
  real title, then `tool_call_update` with the outcome. Only the last two were handled, so
  nothing appeared until Kiro had worked out what to call the step — the panel sat on
  "Working…" through the whole of that gap.
- **A step no longer shows up as `read`.** That first notification's title is only the
  tool's kind, so it now reads `Reading`, `Searching`, `Editing`, `Running` until the real
  title arrives and replaces it.
- **Each step says why Kiro is running it.** Kiro sends its own note — "Read package.json
  to get the version string." — which is the part worth unfolding the list for: the title
  says what, this says what for.
- **Steps are written to the log.** There was no record of them at all, so a turn that
  showed no steps could not be told from one that ran none. `Kiro Chat: Show Log` now has
  a `[tool]` line per update.

## 0.17.1

- **The sent message no longer names the same file twice.** A message sent with a
  highlight carried both `media/chat.js` and `media/chat.js:23-27` under it — the second
  says everything the first did. Only the range survives, named the way the chips are:
  the file's name, with the whole path in the tooltip. This is the same fix 0.15.1 made to
  the chip row above the box; the transcript had its own copy of the problem.
- **Code blocks take the editor's background.** `textCodeBlock` is a faint wash meant to
  sit inside prose, and against the sidebar it was nearly invisible — the block read as
  more paragraph. It is now the colour the code would have in a tab: clearly darker than
  the sidebar on a dark theme, clearly lighter on a light one.
- `Worked for 0s` no longer appears over a reply that came straight back. The line is
  worth a row only when the turn ran long enough to wonder about.
- **The working line says what Kiro is doing**, not just that it is doing something —
  `Reading src/kiroSession.ts`, `Searching for readUsage in src`, `Editing chat.js` — with
  the elapsed time beside it, updating as each step starts. It falls back to `Working…`
  before the first step, and becomes `3 steps` once the turn is over. The full list is
  still one click away on the same line, and still closed by default.

## 0.17.0

- **The turn shows its elapsed time, and the steps fold away.** One line — `Working… 14s`
  with a turning ring — sits where the answer will appear and keeps counting while the
  reply streams, which is the thing that tells a slow turn from a stuck one. The tool
  steps are behind it, closed; click to open them. When the turn ends the line becomes
  `3 steps · 14s`, still closed.
- **No ticks while the work is going on.** A column of them piling up beside steps still
  running was noise, and the row that matters is the one still going. The marks appear
  once the turn is over. A failure is always marked.
- **The blinking `▌` no longer stands in for a reply.** It appeared as soon as the first
  chunk arrived, even an empty one, so a turn that had not really started showed a bare
  cursor on an empty line. It waits for text now, and `Working…` holds the place.
- **Code blocks are syntax coloured, following your theme.** VS Code does not hand a
  webview the editor's TextMate token colours, so this cannot be identical to the editor.
  What it does expose is the theme's own colour keys for the same ideas, and comments,
  strings, numbers, keywords and function names are coloured from those — so the block
  moves with whatever theme you are running rather than fighting it. Light and dark both
  have sensible fallbacks for a theme that leaves a key undefined.
- **The copy button is smaller and has lost its border** — just the glyph, taking a ground
  only under the pointer.

## 0.16.0

The transcript.

- **The panel says when Kiro is working.** Between pressing Send and the first token —
  however long Kiro spends thinking and running tools — the transcript said nothing at
  all, so a slow turn was indistinguishable from a dead one. The only sign was the status
  dot at the very top of the panel, nowhere near where the answer appears. A "Working…"
  line now goes in the moment the message is sent, where the reply will land, and the
  reply replaces it.
- **Tool steps show their state.** "Reading chat.js — running" put the state in the same
  grey prose as the name, so a step still going looked like one that had finished. Each
  row now carries a turning ring, a green tick or a red cross. A reopened chat shows
  finished marks rather than spinning over a turn that ended last week.
- **Code blocks have a copy button.** It sits in the top-right of the block, appears on
  hover or keyboard focus, and turns into a green tick when the code is on the clipboard.
  Where a policy blocks the clipboard outright it selects the code instead and says to
  press Ctrl+C, rather than looking like a button that did nothing.
- **Your own message is a block now.** Both turns were plain full-width prose separated
  only by a small uppercase label, and the question was painted in the *muted* colour — so
  your own words were the faintest thing on screen and scrolling back through a long chat
  gave the eye nothing to catch on. The question sits on its own quiet surface at full
  contrast; the answer stays plain prose, which is what long text wants in a narrow
  column.
- The blinking cursor no longer appears on an empty reply, where it claimed a reply had
  started before the first token arrived. Both new animations stop entirely under
  `prefers-reduced-motion` — the words and marks carry the state without them.

## 0.15.1

- **The selection chip cannot be dismissed any more.** Its × switched off sending the
  highlighted code while the code stayed visibly highlighted in the editor — two places
  disagreeing about the same thing, with nothing on screen saying which was true. The chip
  reports the highlight now; clearing the highlight is what stops it being sent, which is
  the editor's job. `kiroChat.sendSelection` remains the switch for turning the whole
  behaviour off, and is now the only thing that decides it.
- **Chips show the file's name, not its path.** `media/chat.js:26-26` spent most of a
  narrow sidebar on a folder you are already working in; it reads `chat.js:26-26`, with
  the full path in the tooltip. Nothing sent to Kiro changes — it still gets the full path.
- **Chips got their hover back.** They were solid badge-grey blocks — colours meant for a
  count on a tab — with no state of their own, so a chip you can click to open a file
  looked exactly like one you cannot, and the × had only an opacity nudge to show it was
  live. Chips are now a bordered surface; the ones that open a file lift under the
  pointer, and the × is a real 18px target that turns red.

## 0.15.0

The chip row, and a review of what Kiro is actually sent.

- **One chip for a highlighted selection.** A selection always comes from the file you are
  looking at, so the row named the same file twice — `media/chat.js` beside
  `media/chat.js:26-26  1 line`. It is now just `⌗ media/chat.js:26-26`; the range already
  says how many lines it is. Switch the selection off and the file chip comes back, since
  then it is the only thing still being sent.

Three ways Kiro was being told the wrong thing, found by reviewing that path:

- **Selecting inside a diff sent a path that exists nowhere.** The change-review tab is a
  document like any other, so clicking in it — which is how its keyboard shortcuts are
  used — made it the active editor, and the next message told Kiro "I am looking at
  `/a1b2c3/chat.js (Working Tree)`". Selections are now only read from real files;
  git's read-only sides, search results and output panes are ignored for the same reason.
- **Selected code containing ``` escaped its own code block.** Markdown ends a fenced
  block at the first line with as many backticks as opened it, so highlighting a markdown
  file, a template literal or a docstring spilled the rest of the message out of the
  block — Kiro read the user's code as prose. The fence is now always longer than the
  longest run of backticks in the selection.
- **A selection cut at 12,000 characters claimed to be whole.** Kiro was told "lines 26 to
  480" over a block holding only the first part, so an answer about the end of the
  selection was about code it never saw. It now says how much it was given.

`buildBlocks` and the selection rules moved to `src/promptBlocks.ts`, free of `vscode` so
they can be tested directly. None of this had a test before.

## 0.14.2

- **Past chats no longer flash blue when you point at a row.** The row already tints on
  hover; the blue was the global button style leaking through on top of it. A row's
  clickable area is a `<button>`, and while it cancels the button background it could not
  cancel `button:hover` — a type plus a pseudo-class outranks a single class — so the
  whole row repainted in the primary colour under the pointer. The same leak was fixed on
  attachment chips, and a test now fails for any plain-looking button that cancels the
  background without also cancelling the hover.
- **The "Ask in VS Code Chat" button is gone from the title bar.** It opened VS Code's own
  chat with `@kiro` typed, which is the only box that accepts a dragged file — still there
  in the command palette, just no longer taking up a slot in the title bar.

## 0.14.1

- **The past-chats list is quieter.** The "New chat" button is gone — the title bar
  already has one, and a second competing with the rows was a duplicate. Deleting a chat
  no longer asks first; the `×` still stays hidden until you point at the row, so it is
  never under the cursor of someone aiming at the chat beside it.
- **The list is restyled.** The open chat was painting as a solid selection block, which
  repaints its preview line and timestamp in the selection foreground — the greys that
  make them read as secondary text had nothing to be muted against, so every row was one
  flat colour. It is now a soft tint with an accent bar down the left. Rows are rounded,
  hover fades in rather than snapping, the `×` is a proper icon button that turns red
  under the pointer, and the search box takes a single focus ring.

## 0.14.0

Past chats. Three of these lost or corrupted a chat outright.

- **Reopening a chat no longer binds it to the wrong conversation.** Opening a chat sent
  its stored transcript to the panel and *then* asked Kiro to load the session. The panel
  reported that transcript straight back, which beat the load every time, so the chat was
  re-saved carrying whichever session was still running — the previous chat's. Reopening
  it after that resumed the wrong conversation. The panel no longer reports back a
  transcript it was handed, and the session a chat belongs to is pinned before anything
  can be reported.
- **Reading a chat no longer moves it to Today.** The same round trip re-saved the record
  with the current time, so browsing the list quietly reordered it.
- **Two paths silently overwrote a chat.** "Try again" on the setup screen, and a panel
  rebuilt with nothing in it, both started a new conversation without putting the old one
  away or giving the new one its own id — so the new chat was written into the old chat's
  record and replaced it. All three ways of starting a chat now go through one place.
- **A long chat no longer renames itself.** Only the last 120 messages are stored, and the
  title was re-derived from those, so a chat renamed itself the moment its opening message
  dropped out of the window. A chat now keeps the name it has. Where the older messages
  really are gone, the chat says so instead of appearing to begin in the middle.
- **The chat limit is per folder.** One busy project used to evict a quiet one's history.
- **Saving is debounced.** Every message rewrote every stored chat, transcripts and all.

And the list itself:

- **Chats show their newest line**, because titles repeat — real chats open with "fix
  this" — and a column of identical rows cannot be read.
- **A search box** appears once there are more than five.
- **Deleting asks first.** It was one click, permanent, on rows that can look identical.
  The `×` also now stays out of the way until you point at the row or tab to it.
- **Escape leaves the list**, and there is a **New chat** button in it, so getting out
  does not mean hunting for the button in the title bar.
- **The keep-or-undo bar is cleared** when you open another chat. It used to stay pinned,
  offering to undo edits made in a conversation no longer on screen.

## 0.13.1

- **The review tab is named the way git names a diff**: `chat.js (Working Tree)` rather
  than `Review chat.js`. It follows the convention the editor already teaches instead of
  inventing one. Naming it this way means the tab no longer ends in the file's extension,
  so VS Code can no longer work out the language on its own — the review now takes the
  language from the real file and sets it explicitly, and the diff keeps its syntax
  highlighting.

## 0.13.0

- **Ctrl+Z now undoes a change you accepted.** Accepted content was written straight to
  disk, which the editor never sees: the document reloaded with no undo entry, so the
  change was effectively permanent and the chat's own undo was the only way back. Accepted
  content now goes through VS Code's own edit, so it lands on the file's undo stack like
  any edit you made yourself. Putting a file back after a rejection stays a plain disk
  write — that has to be exact, and saving it would run format-on-save.
- **The review tab is named apart from the file.** It was labelled exactly like the real
  file, so two identical-looking tabs sat side by side and it was easy to start typing in
  the wrong one. It now reads `Review chat.js`, keeping the extension so syntax
  highlighting still works.
- **Format-on-save no longer breaks a review.** Saving an accepted change runs your
  formatter, so what lands on disk is not byte for byte what was accepted. That looked
  like somebody else editing the file mid-review: every decision after the first was
  refused, and the review never finished. It now reads the file back and believes it.

## 0.12.1

- **A file you answered in the diff is no longer asked about again.** Deciding every hunk
  and then being asked "keep all changes or undo?" is the same question twice, and the
  second one cannot be answered without contradicting the first. The keep-or-undo card now
  only covers changes that never went through a review — where it is the only gate there
  is. This is the same one-gate rule that already stops an edit being approved before the
  diff is shown.
- **Walking the changes works like resolving a merge conflict.** Clicking the
  "Reviewing … — 2 changes left" line takes you to a change; clicking it again takes you to
  the next. The separate **Next change** button is gone — it was a third control competing
  with the two decisions next to it. `Alt+F5` / `Shift+Alt+F5` in the review editor and the
  links at the top of the diff are unchanged.

## 0.12.0

- **The keep-or-reject card is back.** The webview half of it had gone missing from
  `media/chat.js`, so the extension announced every open review and finished turn into
  nothing: no card appeared above the message box, and the only way to answer an edit was
  to find the diff tab yourself. The card is restored, and there are now tests that fail
  if the webview stops listening for `reviewActive` or `turnChanges`.
- **You can jump between the proposed changes.** A file with several edits meant scrolling
  and hunting for the next coloured line. There is now a **Next change** button on the card
  in the chat, **Next change** / **Previous change** links at the top of the diff, and
  `Alt+F5` / `Shift+Alt+F5` in the review editor. The walk wraps round at either end and
  only visits changes still waiting for a decision, so it empties out as you work through
  them.

## 0.11.3

- **Fixes the review getting stuck part-way through.** Accepting a change writes it to
  disk, which takes a moment, and a second click arriving before that finished was thrown
  away silently. The count stopped going down, the button appeared to do nothing, and
  because the last decision never registered the review never finished — leaving the chat
  bar reporting changes that were no longer there. Decisions now wait their turn instead
  of being discarded.

## 0.11.2

- **Fixes the inline diff not appearing at all.** The extension predicted what each of
  Kiro's edits should produce and abandoned the review unless the file matched that
  prediction exactly. The prediction drifts for entirely ordinary reasons — several edits
  to one file, or a replace it models differently from Kiro — and when it drifted you got
  "no longer matches Kiro's proposed edit, so it was left untouched" **and Kiro's edit
  stayed on disk unreviewed**, which is the one outcome the review exists to prevent. The
  review now always shows what is actually on disk against the file as it was before the
  turn. A mismatch is noted in the log instead of cancelling anything.
- **Closing the review tab no longer throws away changes you already accepted.** Accepting
  a hunk writes it immediately, but closing the tab afterwards rewrote the original over
  the whole file, silently undoing it. Closing now keeps every hunk you accepted and drops
  only the ones you never decided. Cancelling the turn still discards everything, since
  the whole run is being abandoned.

## 0.11.1

- **The keep-or-undo controls now sit just above the message box** instead of in the
  conversation, so they stay put while you scroll and while you read the diff in another tab.
- **They appear the moment the inline diff opens**, not after the turn finishes. You can
  decide each change in the diff, or take **Keep all changes** / **Reject all changes** from
  the chat without walking through every hunk. The bar counts down as you decide.
- Once the review is done it becomes the after-the-turn summary, listing what changed with
  **Undo all changes** still available.

## 0.11.0

- **The chat now asks whether to keep everything a turn changed.** When Kiro finishes
  editing, a card appears with **Keep all changes** and **Undo all changes**, listing the
  files it touched and marking each as created, changed or deleted. Undo puts every one of
  them back exactly as it was before the turn.
- The card only counts files that really changed. A review you rejected, or a file Kiro
  rewrote with what it already contained, is not offered — there would be nothing to undo.
- Undo disables itself while it runs, so it cannot be fired twice, and a new turn replaces
  the card instead of stacking another.

## 0.10.3

- **Fixes Accept and Reject doing nothing in 0.10.2.** Those buttons were drawn as inlay
  hints, which VS Code paints as chips but only makes clickable while a modifier key is
  held — so an ordinary click was ignored. They are ordinary clickable actions again,
  still labelled just **Accept** and **Reject** with no icons, and **Accept all** /
  **Reject all** at the top of the file.
- The numbered badge over every hunk stays gone.

## 0.10.2

- **The "Review change N of M" badge over every hunk is gone.** The Accept and Reject
  controls already say what the block is for.
- **Per-hunk actions are now buttons, labelled just Accept and Reject.** They were plain
  text links with icons and a numbered scope. They are drawn as chips at the end of the
  changed line, using VS Code's inlay hint styling, and respond to an ordinary click.
- Whole-file actions at the top are now **Accept all** and **Reject all**, without icons.

## 0.10.1

- **An edit now asks you once, at the moment you can answer.** Kiro editing a file used to
  need two approvals: a permission card asking "may I write this file?", and then the
  review diff asking "keep these changes?". The first was asked before there was anything
  to look at, so there was no way to answer it properly. Kiro now makes the edit and the
  diff is the only gate — the first thing you see is what actually changed.
- The permission card still appears whenever no diff is coming: with
  `kiroChat.reviewFileWrites` off, `kiroChat.allowFileWrites` off, or in the read-only
  **Plan** workflow. In those cases it is the only gate there is.
- Tools that are not edits are unaffected and still ask first.

## 0.10.0

- Review hunks now carry a theme-aware blue **Review change N of M** badge, and the
  CodeLens actions use stronger bracketed **Accept / Reject** labels with their shortcuts.
- The composer now offers **Default, Spec, Quick Spec, Bug Fix, and Plan** modes, including
  a description for each mode and persistence when the panel moves or reloads.
- The selected workflow is applied to every request. **Plan** is enforced as read-only:
  callback writes are refused and direct Kiro writes are restored automatically.

## 0.9.1

- **Nearby edits no longer collapse into one file-sized review action.** Every contiguous
  changed block is now its own selectable hunk, even when only one unchanged line separates
  it from the next edit.
- Per-hunk CodeLens actions are numbered, for example **Accept change 2 of 4**, so their
  exact scope is clear and distinct from the whole-file controls at the top.

## 0.9.0

- **Reviews now render directly in a source editor tab.** Original lines have a red
  background and proposed lines have a green background, using the active VS Code theme's
  diff colours.
- Every pending hunk has prominent CodeLens actions for **Accept this change** and
  **Reject this change**. `Alt+Enter` accepts the hunk under the cursor and
  `Shift+Alt+Enter` rejects it.
- Accepting writes that hunk immediately, removes its original red lines, and clears its
  decorations. Rejecting removes its proposed green lines and restores the original block.
  External file changes still abort the review instead of being overwritten.

## 0.8.0

- **Changed sections can now be accepted or rejected independently with obvious buttons.**
  The review opens as an editor tab with a separate diff card for every hunk and large
  **Accept this change / Reject this change** controls beside it.
- **Accept entire file / Reject entire file** remain available in a sticky toolbar, and
  progress shows how many changed sections are left to review. Closing the tab safely
  rejects the proposal.

## 0.7.0

- **Tool approval now happens inside the Kiro chat.** Permission requests render as an
  inline card with Kiro's available choices instead of opening a modal VS Code popup.
- **Change review now uses VS Code's native diff editor.** The proposed side shows
  **Accept File / Reject File** actions and **Accept Hunk / Reject Hunk** actions directly
  above each changed section. The separate line-checkbox review page has been removed.
- Closing the native diff still rejects undecided changes, and reviews remain serialised
  when Kiro edits several files.

## 0.6.2

- **Change review now works in multi-root workspaces.** Version 0.6.1 checked edits
  against only the first workspace folder, so a file in another open root was mistaken
  for an outside-workspace path and skipped. All open roots are now accepted while paths
  outside every root remain blocked.

## 0.6.1

- **Review now catches Kiro CLI 2.21's real edit path.** Kiro's built-in `FileWrite`
  tool edits the workspace directly instead of calling the ACP `fs/write_text_file`
  callback. The extension now captures those tools too, restores each file to its
  pre-turn contents, and opens the same file/hunk/line review before unlocking chat.
- Cancelling a turn restores any direct edits it already made. With file writing turned
  off, direct Kiro edits are also restored instead of bypassing the read-only setting.

## 0.6.0

- **Review Kiro's edits before they touch disk.** Every proposed file write now opens a
  diff with Apply and Reject controls. Changed lines are checked individually, each diff
  hunk has a master checkbox, and you can still apply or reject the whole file at once.
- Closing a review rejects the write. If the file changes in the editor while its review
  is open, the extension refuses to overwrite the newer version.
- Review is on by default. Turn off `kiroChat.reviewFileWrites` to keep the earlier
  immediate-write behaviour, or turn off `kiroChat.allowFileWrites` for read-only chat.

## 0.5.4

- **The drop area is the whole panel, and now looks like it.** It always was — the
  handlers sit on the panel, not on the message box — but the hint said "drop on the box
  below" and the marker was a small label floating near it, so there was no way to know.
  Dragging over the panel now outlines the whole thing and says "Drop anywhere here to
  attach". Dropping on the transcript, or on the status line at the very top, attaches
  just the same.

## 0.5.3

- **You can drop files straight onto the chat panel — hold Shift while you drag.**
  VS Code makes every webview non-interactive during a drag so it can track the drag for
  its own drop targets, but it deliberately stops doing that while Shift is held. Holding
  Shift hands the drop to the panel, which has been ready to receive it since 0.4.7.
  Drop anywhere on the panel; the file attaches and shows as a chip.
- The **Drop files** row is gone for good. Shift-dragging onto the panel replaces it.
- The panel now says how, since a modifier key is not something anyone would guess.

## 0.5.2

- A new **Ask in VS Code Chat** button at the top of the panel opens the chat box with
  `@kiro` already typed. That is the box you can drag files onto — the chat panel itself
  is a webview, and VS Code makes every webview non-interactive for as long as a drag is
  in progress, so a drop can never land on it, anywhere on it.
- The log now says outright when `@kiro` has registered, so "the participant is missing"
  and "you dropped on the wrong thing" can be told apart.

## 0.5.1

- **The Drop files row is gone.** Dragging a file onto `@kiro` in VS Code's own chat box
  does the same job without taking up space in the sidebar.
- **The file you are looking at is no longer offered twice.** Attach a file — by dragging
  it in, with **+**, or from the Explorer — then open that same file, and the chip row
  showed it once as the attachment and again as "the file you are looking at". Only one
  was ever sent, so the second chip claimed something that did not happen. The same goes
  for highlighting code in a file that is already attached: you get the file once and the
  highlighted lines once. Attaching a *different* file still leaves the focused-file chip
  alone.

## 0.5.0

- **Kiro is now in VS Code's own chat box as `@kiro`** — and there, dragging a file in
  works, because that box is part of VS Code rather than a page inside it. Attach files by
  dragging them from the Explorer, by `#`-mentioning them, or with the paperclip; they
  reach Kiro as files it can open, and are echoed back so you can see what went with your
  question. Selected ranges carry their line numbers.
- This is why dropping onto the chat panel could never work: VS Code sets
  `pointer-events: none` on every webview for as long as any drag is in progress, so the
  panel never sees the drop at all. Nothing the panel does can change that; the native
  chat box is not a webview and is not affected.
- **Both boxes share one conversation.** `@kiro` and the panel talk to the same Kiro
  session, so credits, context and memory stay in one place rather than two agents running
  side by side. Asking in one while the other is mid-reply says so rather than tangling
  the two.
- Answers stream in as they arrive, tools show as progress, and stopping the reply in the
  chat box stops Kiro.
- The panel keeps everything it had — model picker with credit rates, usage, past chats,
  the focused-file chip. Nothing was removed.

## 0.4.9

- **Fixes a bad regression in 0.4.8.** Adding the drop target could fail on start —
  VS Code only picks up a new view after a full restart, so a window that had merely been
  reloaded rejected it with "No view is registered". Everything was registered as one
  statement, and the arguments to it are all evaluated before it runs, so that one failure
  meant every command after it was never registered: the panel appeared but **New
  Session**, **Restart Agent**, **Past Chats**, **Show Usage** and `Ctrl+Alt+K` all did
  nothing. The drop target is now registered on its own and cannot take anything with it.
- If it still cannot register, the panel says so in **Kiro Chat: Show Log** and everything
  else carries on working — only dragging files in is unavailable until VS Code is closed
  and opened again.

## 0.4.8

- **Dragging files from the Explorer works.** It could never work on the chat panel
  itself. VS Code makes every webview non-interactive for the duration of any drag
  anywhere in the window — it sets `pointer-events: none` on the panel the moment a drag
  starts — so no drop event ever reached it, whatever the panel did about it. There is now
  a **Drop files** row under the chat which accepts the drag instead.
- What you drop is attached to your next message and appears as a chip above the message
  box, the same as anything you attach with **+**. The row sits collapsed under the chat
  and can stay that way.
- The **+** button and the Explorer right-click **Add to Chat Context** work as before.

## 0.4.7

- **Dragging files onto the panel is more likely to work, and says so when it does
  not.** A dragged file is offered under several format names at once, and which ones are
  filled in depends on where the drag came from — the panel read one of them and gave up
  quietly if it was empty. It now reads every format, unpacks all the shapes they arrive
  in, and drops the same file only once when two formats describe it.
- Dropped files appear as chips above the message box, alongside the file you are looking
  at, and a reference is written into your message as before.
- **Dragging a picture in from outside VS Code** — Windows Explorer, a browser — now
  attaches it as an image, the same as pasting a screenshot.
- If a drop is not understood, **Kiro Chat: Show Log** now records which formats the drag
  actually offered. A drop that reached the panel and one that never arrived used to look
  identical; they no longer do.

## 0.4.6

- **The file you are looking at goes with your message**, the way Copilot Chat does it. It
  shows as a chip above the message box and is attached, so Kiro can open it rather than
  just being told its name. Before this, a file with nothing selected was mentioned in the
  prompt as "I am looking at …" and never attached — Kiro knew the filename and could not
  read it, and nothing on screen said so or let you stop it.
- Click the chip's **×** to leave the file out. That means "not this file": switching to a
  different file brings it back, but moving around inside the same one does not. Switch it
  off for good with the new **Kiro Chat: Attach Active File** setting.
- If you have already attached the same file with **+**, it is not attached twice.
- Highlighted code still shows as its own chip alongside, so Kiro gets the file to read and
  the exact lines you meant.
- **`kiroChat.sendSelection` now works.** It was offered in settings but nothing in the
  code ever read it, so turning it off did nothing. There is now a check that every setting
  the extension advertises is actually used.

## 0.4.5

- **Reopening a past chat no longer wipes the model credit rates.** Reopening rebuilt the
  model list from what Kiro sends back when it loads a conversation — and that list, like
  the one for a new session, carries no rate. The rates come from Kiro's separate `model`
  command, which was only being asked for when connecting, so after reopening a chat every
  model showed a blank rate for the rest of the session. It is now asked for again.

## 0.4.4

- **Usage opens as a dropdown instead of landing in your conversation.** The account
  report used to be posted into the chat as messages, which shoved the transcript around
  — and, because it went through the same path as a real message, it was saved into your
  chat history as though you had asked for it there. It is now a panel under the credits
  strip: click the strip, or the graph icon at the top of the panel, and click again to
  close it. Clicking elsewhere or pressing Escape closes it too. Reopening shows what was
  already fetched rather than asking Kiro again; **Refresh** asks for fresh figures.
- The credits strip now shows a caret, so it looks like the button it has become.

## 0.4.3

- **Past chats.** The clock icon at the top of the panel lists the conversations you have
  had in this folder, grouped by Today, Yesterday and then by date. Click one to reopen
  it, or the **×** to forget it. Starting a new chat with **+** used to throw the old one
  away; it is now kept.
- Reopening a chat genuinely continues it. Kiro is asked to load the session back, so it
  has the conversation in mind and you can carry on talking rather than reading a
  transcript. Chats are listed per folder, because Kiro ties a conversation to the folder
  it happened in. If Kiro cannot take a conversation back, the chat still opens so you can
  read it, and the message box says it is read-only instead of quietly starting a
  different conversation when you reply.
- History starts empty: chats are recorded as you talk, so conversations from before this
  version are not in the list.
- **Attached images show the picture.** They were listed by filename, because the image
  data was being stripped before the panel ever saw it. Screenshots now appear as
  thumbnails, both on the chip above the message box and in the message once sent. Very
  large images still show as a filename rather than being pushed through as a thumbnail.

## 0.4.2

- **Restarting the agent no longer tells you to sign in again.** Every failure between
  starting Kiro and getting a session — a slow start, a dropped pipe, a missing session id
  — was reported as "you are not signed in", which on a restart is almost always wrong,
  since you were chatting seconds earlier. The real error is now shown, and only a genuine
  login problem sends you to sign in.
- A restart shows **Connecting to Kiro…** in the panel rather than looking like nothing is
  happening. It also retries quietly a few times first, so a temporary failure fixes itself
  without showing you anything.
- **Stop** no longer appears while Kiro is merely starting up, when there is no reply to
  stop.
- **The setup screen sets itself up.** If Kiro's command line tool is not installed, the
  panel now watches for it appearing and connects on its own — the steps tick over as it
  happens and the panel turns into a chat without you clicking anything. Clicking
  **Install Kiro** still only types the command into PowerShell for you to run; nothing
  runs behind your back. There is a **Copy the install command** link if you would rather
  do it yourself.
- The message box is disabled while setup is on screen. You could previously type a
  question and press Send into a Kiro that was not running, and nothing said why.
- **The panel is one column, top to bottom.** Your messages were right-aligned bubbles,
  which gave the transcript two things to follow at once and felt cramped in a narrow
  sidebar. Both you and Kiro now run the full width with a small label above, so the eye
  travels straight down. Fewer borders and boxes throughout.

## 0.4.1

- Fixed the panel painting things that were meant to be hidden. The attach menu, the
  "Drop to add as context" overlay, the usage strip and the attachment chip row were all
  stuck on screen permanently, because the stylesheet outranked the `hidden` attribute.
- The attach menu now opens above the **+** button instead of floating over the message
  box, and the model list stays inside the panel on a narrow sidebar.
- **Usage** works. The request was malformed — Kiro wanted the command as a tagged object
  and got the string `"/usage"`, so it rejected every attempt and the panel answered
  "Kiro would not report account usage here" every single time. It now sends the shape
  Kiro accepts and shows your real plan: name, credits used against your limit, renewal
  date, and whether overages are on. Those figures stay on the usage strip and under the
  model list afterwards.
- **Model credit rates now appear.** The model list Kiro sends with a new session carries
  no rate at all, which is why the column was always empty. The rates come from Kiro's
  `model` command instead, which the panel now asks for on connecting — so every model
  shows what it costs, like `2.2x`, along with its context window.
- The model list has a credits footer, so what this chat has cost, and what your plan has
  left, is visible from the place you pick a model.
- Credits and the context meter are read from ordinary session updates as well as from
  the metadata notification, so the strip fills in instead of staying blank.
- Kiro Chat now finds the Windows CLI at `%LOCALAPPDATA%\Kiro-Cli\`, where the current
  installer puts it, instead of relying on it being on your PATH.
- Windows: pointing `kiroChat.command` at a `.cmd` or `.bat` shim failed with a bare
  "spawn EINVAL" and the sign-in screen, because Node will not launch one directly any
  more. Those now start through the shell, quoted, so a path with spaces works too.
- Windows: no console window flashes up when the agent starts.
- Windows: with no folder open, Kiro was started in whatever directory VS Code itself was
  launched from — usually its own install folder — and file access was fenced to that.
  It now falls back to your home directory. The old fallback read `HOME`, which Windows
  does not set.
- Pressing Enter while Kiro was working started a second turn on top of the first. It no
  longer does.
- Long replies no longer flicker: the transcript repaints once per frame rather than once
  per streamed chunk.
- A code block opened part-way through a sentence rendered as raw placeholder text.

## 0.4.0

- Opening the panel now gives you a connected, empty chat straight away, instead of sitting
  at "Not connected" until you typed something.
- The panel can be moved. Drag its icon to the bottom panel or the secondary sidebar on the
  right, or run **Kiro Chat: Move Panel**. Your conversation survives the move.
- Dropping a file or folder now writes a reference into the message box at your cursor, so
  the text says what you mean, for example `explain @src/api/routes.ts`. The message box
  highlights as the drop target while you drag.

## 0.3.0

- The model list now shows each model's description, with its credit rate on the right.
  The rate appears only when Kiro reports one, never a guess.
- A usage strip shows credits spent in this chat and how full the context is, turning
  amber past 80%. The **Usage** button asks Kiro for your account picture.
- Paste a screenshot straight into the message box, or attach an image file.
- The code you highlight now shows as a live chip above the text box, with the file and
  line numbers, and goes with your message. Click the chip to leave it out.
- Attach files and folders with the **+** button, or right-click them in the Explorer and
  choose **Add to Chat Context**.
- Drag files and folders from the Explorer straight onto the panel.

## 0.2.0

- Pick your model from a dropdown at the bottom of the chat panel, or with
  **Kiro Chat: Change Model**. The list comes from your own Kiro account, and your choice
  is remembered.
- A guided setup screen now appears when Kiro is not installed or you are not signed in,
  with buttons that open a terminal with the right command already typed.
- Finds Kiro on Windows automatically, including the native install at
  `C:\Program Files\Kiro-Cli\` and installs that live inside WSL.
- Upgrading now keeps all your settings, and tells you what changed.
- If your saved path to Kiro stops working, the extension falls back to searching for it
  instead of just failing.
- Requests can no longer hang forever. A stale session used to freeze the panel with no
  error at all.

## 0.1.0

- First version. Chat sidebar, streaming replies, your open file and selection sent as
  context, explain-selection from the editor right-click menu.
