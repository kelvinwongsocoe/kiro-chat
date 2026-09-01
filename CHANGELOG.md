# Changelog

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
