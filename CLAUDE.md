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

`KiroSession.handleRequest` answers `fs/read_text_file`, `fs/write_text_file` and `session/request_permission`. **Every file path goes through `resolveInsideWorkspace`**, which rejects anything resolving outside the open folder. That function is the security boundary — don't route file access around it. Writes additionally check `kiroChat.allowFileWrites`.

The extension advertises `terminal: false` in its client capabilities, so Kiro never asks to run shell commands.

### Kiro-specific protocol quirks

These are the things that were expensive to discover; the comments in `kiroSession.ts` cover them at length:

- **`runCommand`** hits `_kiro.dev/commands/execute` with an adjacently-tagged enum: `{ sessionId, command: { command: "usage", args: {} } }`. A plain string, or a name with a leading `/`, is rejected outright.
- **`textSpy`** — Kiro's own commands narrate through the ordinary `agent_message_chunk` stream. The spy diverts that so command output doesn't land in the transcript as if the user had asked for it.
- **Credit rates need a second call.** The model list returned by `session/new` carries no rate; only the `model` command has `rateMultiplier` and the context window. `enrichModels()` fetches it in the background after connecting.
- **The usage meter arrives two ways** — as a `_kiro.dev/metadata` notification, and sometimes bolted onto an ordinary `session/update`. `handleNotification` reads both; dropping either leaves the usage strip blank for a whole conversation.
- `session/prompt` is sent with the payload under **both** `prompt` and `content`, because Kiro's docs and the ACP spec disagree on the field name.

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
- Kiro also exposes **modes** (`kiro_default`, `kiro_planner`, `kiro_guide`) that the panel does not surface at all. Unclaimed feature.

## Chat history

Records live in `context.globalState` under `kiroChat.history`. The transcript itself is maintained by the **webview** (it already did, for surviving panel moves) and posted up as a `transcript` message after each turn — one source of truth rather than accumulating chunks in the extension host too.

Chats are filtered to the open folder, because Kiro binds a session to its `cwd` and a chat from another project cannot meaningfully resume. `forWorkspace` normalises Windows path spellings; comparing raw strings would silently hide the user's own chats.

A chat whose `session/load` fails still shows its transcript, but the composer locks — replying would otherwise start a *different* conversation without saying so.

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
