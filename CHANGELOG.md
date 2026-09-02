# Changelog

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
