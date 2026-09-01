# Changelog

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
