# Kiro Chat for VS Code

A chat sidebar in VS Code that talks to Kiro, the way Copilot Chat does.

## Setup on Windows

**1. Install the extension.** Double-click `install-windows.bat` in this folder.

If that says the `code` command is missing, do it by hand instead: open VS Code, click
Extensions in the left bar, click the **...** menu at the top, choose **Install from
VSIX...**, and pick `kiro-chat.vsix` from this folder.

**2. Restart VS Code and click the Kiro icon in the left bar.**

**3. Follow whatever the panel tells you.**

If Kiro's command line tool isn't on your machine yet, the panel shows a short setup screen
with buttons. Clicking them opens a terminal with the right command already typed in. You
press Enter to run it. Nothing runs behind your back.

If Kiro is already installed and you're signed in, the panel skips all of that and is ready
to chat.

## Where the panel lives

It starts in the left bar, but it does not have to stay there. **Drag the Kiro icon** to the
bottom panel or to the secondary sidebar on the right, whichever suits how you work. Or run
**Kiro Chat: Move Panel** from the command palette and pick a spot.

Your conversation is kept when you move it. VS Code rebuilds the panel from scratch on a
move, so the extension saves the transcript and puts it back.

One VS Code rule worth knowing: extensions are not allowed to place a panel in the secondary
sidebar themselves. Only you can drag it there. That is why it starts on the left.

## Using it


- Open the panel and you get a fresh chat, already connected. No button to press first.
- Type, press **Enter** to send. **Shift+Enter** for a new line.
- Press `Ctrl+Alt+K` to jump to the chat from anywhere.
- Whatever file you have open, and any text you've highlighted, is sent along so Kiro knows
  what you're looking at.
- Right-click highlighted code and choose **Kiro Chat: Explain Selection**.
- **Stop** cuts off a reply. The **+** at the top starts a fresh conversation.

## Updating to a newer version

**Short answer: it does not update itself, and that is a VS Code rule, not a choice I made.**

VS Code switches auto-update off for any extension installed from a `.vsix` file. Only
extensions installed from a marketplace update on their own. So when you get a newer
`kiro-chat.vsix`, you install it the same way you installed the first one.

That part is handled properly:

- Run `install-windows.bat` again with the newer file. It sees the version already
  installed, replaces it, and tells you the old and new version numbers.
- **Your settings are kept.** Model choice, Kiro path, tool approvals, all of it.
- On the next start, the panel tells you it updated and offers to show what changed.
- Installing by hand through **Install from VSIX...** works the same way. You do not need
  to uninstall first.

Run **Kiro Chat: About and Check Version** any time to see which version you are on.

## Context: telling Kiro what to look at

**The code you highlight is sent automatically.** Select something in the editor and a chip
appears above the message box showing the file and line numbers, like
`src/app.ts:12-40  3 lines`. It follows your cursor as you move. Click the chip to leave the
selection out of a message, and click again to put it back.

**Attach files and folders** with the **+** button next to the message box. It offers a
searchable list of everything in your project, a folder picker, or an image.

**Right-click in the Explorer** and choose **Kiro Chat: Add to Chat Context**. Select
several things first and all of them are added.

**Drag and drop** files or folders from the Explorer onto the message box. The box
highlights as you drag over it. When you drop, a reference is written into your message at
the cursor, so you can carry on typing around it:

```
explain @src/api/routes.ts and how it uses @src/models
```

The dropped items are attached as well, so Kiro can open them.

Attached items show as chips. Click a chip's name to open that file, or the **×** to remove
it. Attachments clear once the message is sent.

One detail worth knowing: Kiro reads attached files itself rather than having their contents
pasted into the message. It reports that it will not accept file contents inlined in a
prompt, so the extension passes the paths and lets Kiro fetch what it needs. Your highlighted
selection is the exception, since that is short and goes in directly.

## Screenshots and images

Paste an image straight into the message box with `Ctrl+V`. Take a screenshot with Windows'
`Win+Shift+S`, click the message box, paste, and it attaches.

You can also use **+** then **An image** to pick image files from disk.

If your Kiro version does not accept images, the panel says so rather than silently dropping
them. The extension checks this when it connects.

## Seeing your usage

A strip under the status line shows **credits used in this chat** and **how full the context
is**, updating as Kiro works. The bar turns amber past 80% full, which is the point to start
a fresh chat with the **+** button.

Press **Usage** at the top for your account picture: your plan name, credits used against
your limit, when the cycle renews, and whether overages are switched on. Those figures stay
on the strip and under the model list afterwards, so you do not have to press it again.

This comes from Kiro's own `usage` command, which reports real numbers rather than an
estimate. If your version of Kiro answers with plain text instead, the panel reads what it
can and still shows the report in full. If the command fails, the panel says what went
wrong; **Kiro Chat: Show Log** has the whole exchange.

## Changing the model

There's a dropdown at the bottom of the panel, next to the Send button. Pick a model and it
switches straight away.

It fills itself with whatever models your Kiro account actually offers, so you see real
choices rather than a guessed list. Each row shows the model's description and context
window, with its credit rate on the right, like `1x` or `2.2x`. **auto** is Kiro's default:
it picks a model per task.

The rates come from Kiro's `model` command, which the panel asks for as it connects — the
model list alone does not carry them. If a model still shows no rate, that means Kiro did
not say, not that it is free, and the list says so at the bottom rather than leaving you
guessing.

Under the list is what this chat has cost so far, plus your plan's credits once **Usage**
has fetched them, so the price is in front of you at the moment you pick a model.

Your choice is remembered and used again next time, including in new conversations.

You can also press `Ctrl+Shift+P` and run **Kiro Chat: Change Model** if you prefer a
searchable list.

Two things worth knowing:

- The dropdown locks while Kiro is mid-reply. Switching models halfway through a reply
  confuses the session, so wait for it to finish.
- If the dropdown stays greyed out saying "Model: default", your version of Kiro isn't
  reporting a model list. Everything else still works; Kiro just uses its own default.

## Choosing a workflow mode

The mode dropdown beside the attachment and model controls changes how Kiro approaches the
next request:

- **Default** — general coding assistance.
- **Spec** — structured requirements, design, tasks, and implementation.
- **Quick Spec** — clarify only blockers, then generate a concise spec and proceed.
- **Bug Fix** — investigate, diagnose the root cause, make a focused fix, and verify it.
- **Plan** — analyze and return an implementation plan without changing files.

The choice survives panel moves and reloads and is shown on the sent message. These workflows
are explicit request instructions layered over Kiro's ACP session. Plan also has a hard safety
boundary in the extension: callback writes are refused and any direct Kiro write is restored.

## If it doesn't work

Open the command palette (`Ctrl+Shift+P`) and run **Kiro Chat: Show Log**. It shows exactly
what was tried.

The two usual causes:

- **Not signed in.** Run `kiro-cli auth login` in a terminal.
- **No folder open in VS Code.** Kiro needs a folder to work in.

If the log says it couldn't find `kiro-cli`, run `which kiro-cli` in a terminal and paste
the result into Settings, search "Kiro Chat", field **Command**.

## Which systems this works on

**Windows only.** Mac and Linux support was taken out on purpose, so the code has one path
through it instead of three. On any other system the extension says so and stops rather
than failing later with a confusing "kiro-cli not found".

Kiro CLI 2.0 and newer installs natively on Windows. Use Kiro's PowerShell installer, then
run `kiro-cli login`. To find it, the extension checks the usual install folders — starting
with `%LOCALAPPDATA%\Kiro-Cli\` — then `where kiro-cli`, and finally WSL.

If you are on an older Kiro CLI that only runs under WSL, that still works: the extension
finds it and runs it through WSL for you. One thing to know: keep your project inside the
Linux side of WSL (`/home/you/...`) rather than a Windows drive (`/mnt/c/...`), or file
reads get slow.

If your `kiro-cli` is a `.cmd` or `.bat` shim rather than a real `.exe`, that works too —
those are started through the shell, since Node will not launch them directly.

## How this works

Kiro is its own separate app, so nothing can reach inside it. But Kiro's command line tool
can run as an agent that other editors talk to over a pipe. That's a public, documented
feature, and it's the same one Zed and JetBrains use.

```
VS Code sidebar  ->  this extension  ->  kiro-cli acp  ->  Kiro
```

Everything runs on your own machine. No extra account, no key, no server. It uses the Kiro
login you already have.

## Safety choices worth knowing

- **Reading and writing files is limited to your open workspace folders.** This includes
  every root in a multi-root workspace; a path outside all of them gets refused.
- **Tools ask first inside the chat.** Kiro's permission choices appear as an inline card
  in the current response instead of a separate popup. There is a setting to auto-approve,
  off by default. Only turn it on in a folder you trust.
- **File changes open for inline review before the turn finishes.** Deleted/original lines
  are red and inserted/proposed lines are green in a source editor tab. Each changed section
  has a blue **Review change N of M** marker plus numbered
  **Accept change N of M / Reject change N of M** CodeLens actions; use `Alt+Enter` or
  `Shift+Alt+Enter` with the cursor on a hunk. Whole-file actions remain at the top.
  Accepted hunks are written immediately while rejected hunks collapse back to the original.
  Kiro CLI's built-in edit tool writes directly, so the extension captures its
  result, restores the pre-turn file when the turn ends, and leaves only the lines you approve.
  Closing the tab rejects the write. This is on by default and can be disabled in settings.
- **No terminal access.** The extension tells Kiro it cannot run shell commands, so Kiro
  will not try.
- Text coming back from Kiro is escaped before it is shown, so a reply cannot inject
  anything into the panel.

## Settings

All optional.

| Setting | What it does |
| --- | --- |
| `kiroChat.command` | Path to `kiro-cli`. Leave empty to auto-detect. |
| `kiroChat.args` | Extra arguments, e.g. `["--agent", "my-agent"]`. |
| `kiroChat.env` | Extra environment variables for Kiro. |
| `kiroChat.allowFileWrites` | Let Kiro edit files. Turn off for read-only chat. |
| `kiroChat.autoApproveTools` | Skip the approval popup. Off by default. |
| `kiroChat.reviewFileWrites` | Inline red/green review with whole-file and per-hunk decisions. On by default. |
| `kiroChat.sendSelection` | Send highlighted code with each message. |
| `kiroChat.model` | The model to use. The dropdown sets this for you. |

Settings survive upgrades. If the saved path to Kiro ever stops working, for example
because Kiro updated itself and moved, the extension clears it, goes back to searching, and
tells you it did so, rather than just failing.

## Building it yourself

```
npm run build
```

That installs, compiles and writes `kiro-chat.vsix` next to `install-windows.bat`. Then
double-click `install-windows.bat` to install it, and restart VS Code.

`npm test` runs the checks on their own. There is one GitHub Actions workflow,
`.github/workflows/ci.yml`, which does the same three steps on Windows for every push. It
publishes nothing — the extension is installed from the `.vsix`, not from the Marketplace.

## Not built yet

Images, past sessions, and Kiro's slash commands all exist in the protocol but are not
wired to the UI yet. The pieces are in `src/kiroSession.ts`.
