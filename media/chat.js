(function () {
  "use strict";

  const vscode = acquireVsCodeApi();

  const el = (id) => document.getElementById(id);
  const statusEl = el("status");
  const messagesEl = el("messages");
  const formEl = el("composer");
  const inputEl = el("input");
  const sendBtn = el("send");
  const stopBtn = el("stop");
  const chipsEl = el("chips");
  const attachBtn = el("attach");
  const attachMenu = el("attach-menu");
  const modeBtn = el("mode-btn");
  const modeLabel = el("mode-label");
  const modeMenu = el("mode-menu");
  const modelBtn = el("model-btn");
  const modelLabel = el("model-label");
  const modelMenu = el("model-menu");
  const usageBar = el("usage-bar");
  const usageFill = el("usage-fill");
  const usageText = el("usage-text");
  const usagePanel = el("usage-panel");
  const dropzone = el("dropzone");

  let current = null;
  let buffer = "";
  let models = [];
  let currentModelId = "";
  const CHAT_MODES = [
    { id: "default", label: "Default", description: "General coding assistance" },
    { id: "spec", label: "Spec", description: "Structured feature development" },
    {
      id: "quick-spec",
      label: "Quick Spec",
      description: "Clarify, then generate requirements, design, and tasks",
    },
    {
      id: "bug-fix",
      label: "Bug Fix",
      description: "Investigate, diagnose, and resolve bugs",
    },
    {
      id: "plan",
      label: "Plan",
      description: "Plan the implementation without making changes",
    },
  ];
  let currentModeId = "default";
  let attachments = [];
  let selection = null;
  let includeSelection = true;
  /** The file the editor is showing, sent with the message like Copilot does. */
  let activeFile = null;
  let includeActiveFile = true;
  let canSendImages = false;
  let busy = false;
  let usage = {};
  /** The last account report, so reopening the panel does not refetch. */
  let usageReport = null;
  let usageLoading = false;

  // VS Code destroys and rebuilds this script whenever the view is moved
  // between the sidebar, the panel or the secondary sidebar. Anything we
  // want to survive that has to live in webview state.
  let history = [];
  const MAX_HISTORY = 120;
  /** True once the chat is longer than we can keep, so the tail is all there is. */
  let historyTruncated = false;

  /**
   * `report` is false when the transcript we are holding came *from* the
   * extension — reopening a past chat. Sending it straight back made the
   * extension re-save the record, which bumped its timestamp to now (a chat
   * jumped to Today just for being read) and re-stamped its session id while
   * `session/load` was still in flight, binding it to the previous chat.
   */
  function saveState(report) {
    historyTruncated = historyTruncated || history.length > MAX_HISTORY;
    try {
      vscode.setState({
        history: history.slice(-MAX_HISTORY),
        historyTruncated,
        includeSelection,
        mode: currentModeId,
      });
    } catch (err) {
      // State is a convenience. Never let it break the panel.
    }
    if (report === false) return;
    // Webview state dies with the panel, so hand the same transcript to the
    // extension, which can keep it in the chat history. This fires per turn,
    // not per chunk, so it is not chatty.
    try {
      vscode.postMessage({
        type: "transcript",
        history: history.slice(-MAX_HISTORY),
        truncated: historyTruncated,
      });
    } catch (err) {
      // Same again: never let bookkeeping break the chat.
    }
  }

  function recordUser(message) {
    history.push({
      role: "user",
      text: message.text || "",
      attachments: message.attachments || [],
      selection: message.selection,
      mode: message.mode,
      modeLabel: message.modeLabel,
    });
    saveState();
  }

  function recordAgent(text, tools) {
    if (!text.trim() && (!tools || tools.length === 0)) return;
    history.push({ role: "agent", text, tools: tools || [] });
    saveState();
  }

  function recordSimple(role, text) {
    history.push({ role, text });
    saveState();
  }

  // ---------------------------------------------------------------
  // Markdown. Everything is escaped first, so nothing from the agent
  // can inject HTML.
  // ---------------------------------------------------------------

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inline(text) {
    return text
      .replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  }

  /*
   * The copy control on a code block.
   *
   * Static markup of ours, not anything from Kiro, so it is safe to build by
   * hand here — everything from the agent is escaped before it reaches this.
   * The click is handled by one delegated listener rather than a listener per
   * button, because a streaming reply rebuilds this markup on every frame.
   */
  const COPY_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M4 2.5A1.5 1.5 0 0 1 5.5 1h5A1.5 1.5 0 0 1 12 2.5V3h.5A1.5 1.5 0 0 1 14 4.5v9a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 4 13.5V13h-.5A1.5 1.5 0 0 1 2 11.5v-9A1.5 1.5 0 0 1 3.5 1H4v1.5Zm1 10.5a.5.5 0 0 0 .5.5h7a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5v9ZM4 4H3.5a.5.5 0 0 0-.5.5v7a.5.5 0 0 0 .5.5H4V4Z"/>' +
    "</svg>";
  const CHECK_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">' +
    '<path d="M13.7 4.3a1 1 0 0 1 0 1.4l-6 6a1 1 0 0 1-1.4 0l-3-3a1 1 0 1 1 1.4-1.4L7 9.6l5.3-5.3a1 1 0 0 1 1.4 0Z"/>' +
    "</svg>";

  /*
   * Colouring a code block.
   *
   * VS Code does not expose the editor's TextMate token colours to a webview,
   * so an exact match with the editor is not on offer. What it does expose is
   * the theme's own colour keys, and several of them are the same idea under
   * another name — `debugTokenExpression.string` is the theme's string
   * colour, `symbolIcon.keywordForeground` its keyword colour. Colouring from
   * those follows whatever theme is active instead of hard-coding a palette
   * that fights it.
   *
   * The tokenizer is deliberately small. It marks comments, strings, numbers
   * and keywords and leaves everything else alone, because a wrong colour
   * reads worse than no colour.
   */
  const HASH_COMMENT_LANGS =
    /^(py|python|sh|bash|zsh|shell|console|yaml|yml|rb|ruby|toml|ini|conf|cfg|dockerfile|docker|makefile|make|ps1|powershell|r|perl|pl|nix|elixir|ex)$/;

  const CODE_KEYWORDS = new Set(
    ("abstract and as assert async await break case catch class const constructor continue " +
      "declare def default del delete do elif else elseif end enum export extends finally fn " +
      "for from func function global go if impl implements import in instanceof interface is " +
      "lambda let loop match mod module mut namespace new not or package pass private protected " +
      "public raise readonly require rescue return select static struct super switch then this " +
      "throw trait try type typeof union unless until use var void when where while with yield")
      .split(" ")
  );
  const CODE_CONSTANTS = new Set(
    "true false null nil none None True False undefined NaN Infinity self".split(" ")
  );

  /** Escaped HTML for one code block, with spans around what we recognise. */
  function highlightCode(code, lang) {
    const hash = HASH_COMMENT_LANGS.test(String(lang || "").toLowerCase());
    // `//` is floor division in Python and `#` is a colour in CSS, so the
    // comment style follows the language rather than trying to be both.
    const comment = hash ? "#[^\\n]*" : "\\/\\*[\\s\\S]*?\\*\\/|\\/\\/[^\\n]*";
    const pattern = new RegExp(
      "(" + comment + ")" +
        "|(\"(?:[^\"\\\\\\n]|\\\\.)*\"?|'(?:[^'\\\\\\n]|\\\\.)*'?|`(?:[^`\\\\]|\\\\.)*`?)" +
        "|(\\b\\d[\\w.]*\\b)" +
        "|([A-Za-z_$][\\w$]*)",
      "g"
    );

    let out = "";
    let last = 0;
    let match;
    while ((match = pattern.exec(code))) {
      out += escapeHtml(code.slice(last, match.index));
      last = pattern.lastIndex;
      const text = escapeHtml(match[0]);
      if (match[1]) out += `<span class="tok-comment">${text}</span>`;
      else if (match[2]) out += `<span class="tok-string">${text}</span>`;
      else if (match[3]) out += `<span class="tok-number">${text}</span>`;
      else if (CODE_CONSTANTS.has(match[4])) out += `<span class="tok-const">${text}</span>`;
      else if (CODE_KEYWORDS.has(match[4])) out += `<span class="tok-keyword">${text}</span>`;
      else if (code[pattern.lastIndex] === "(") out += `<span class="tok-fn">${text}</span>`;
      else out += text;
    }
    return out + escapeHtml(code.slice(last));
  }

  function renderMarkdown(rawSource) {
    const blocks = [];
    /*
     * Line endings are normalised before anything else looks at the text.
     *
     * The fence pattern consumed `\n` after the language but not `\r\n`, so a
     * reply with Windows line endings — which is most of them, on Windows —
     * left the carriage return inside the block. Every code snippet came out
     * with a blank line above and below it, and `<pre>` renders a lone `\r` as
     * a break so it was not even visibly whitespace. Doing this once here
     * fixes fences, headings and lists together.
     */
    const source = String(rawSource).replace(/\r\n?/g, "\n");
    /*
     * A fence only opens a block at the start of a line.
     *
     * This used to match ``` anywhere, so a run of backticks *inside a
     * sentence* — "uses longer fences (````)", a shell snippet quoted inline,
     * anything discussing markdown — opened a code block, and the whole rest
     * of the reply was swallowed into it as code. That is what markdown's
     * line anchor is for, and leaving it out is the single worst thing a
     * hand-rolled renderer can get wrong: the more the reply talks about
     * code, the more likely it is to be destroyed.
     *
     * `(?![\s\S])` rather than `$` for the unterminated case: `$` under the
     * `m` flag means end of *line*, which would cut every block at its first
     * newline. Streaming replies rely on that branch.
     */
    const FENCE = /^[ \t]{0,3}```([^\n`]*)\n?([\s\S]*?)(?:^[ \t]{0,3}```[ \t]*$|(?![\s\S]))/gm;
    const withoutCode = source.replace(FENCE, (_, info, code) => {
      // An info string may carry more than the language; the first word is it.
      const lang = String(info).trim().split(/\s+/)[0] || "";
      const index = blocks.length;
      blocks.push(
        '<div class="code-block">' +
          '<button type="button" class="code-copy" title="Copy code" aria-label="Copy code">' +
          COPY_ICON +
          "</button>" +
          // The newline before the closing fence belongs to the fence, not to
          // the code — and neither does the indent in front of it.
          `<pre><code class="language-${escapeHtml(lang || "text")}">${highlightCode(
            code.replace(/\n[ \t]*$/, ""),
            lang
          )}</code></pre>` +
          "</div>"
      );
      // Newlines around it so the placeholder always lands on a line of
      // its own, even when the fence was opened part-way through a sentence.
      return `\n\u0000CODE${index}\u0000\n`;
    });

    const html = [];
    const lines = escapeHtml(withoutCode).split("\n");
    let list = null;
    const closeList = () => {
      if (list) {
        html.push(`</${list}>`);
        list = null;
      }
    };

    for (const line of lines) {
      const codeMatch = line.match(/^\u0000CODE(\d+)\u0000$/);
      if (codeMatch) {
        closeList();
        html.push(blocks[Number(codeMatch[1])]);
        continue;
      }
      if (!line.trim()) {
        closeList();
        continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        closeList();
        html.push(`<h${Math.min(heading[1].length + 1, 6)}>${inline(heading[2])}</h${Math.min(
          heading[1].length + 1,
          6
        )}>`);
        continue;
      }
      const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) {
        if (list !== "ul") {
          closeList();
          html.push("<ul>");
          list = "ul";
        }
        html.push(`<li>${inline(bullet[1])}</li>`);
        continue;
      }
      const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (numbered) {
        if (list !== "ol") {
          closeList();
          html.push("<ol>");
          list = "ol";
        }
        html.push(`<li>${inline(numbered[1])}</li>`);
        continue;
      }
      closeList();
      html.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    return html.join("");
  }

  /*
   * Copying a code block.
   *
   * One listener on the transcript rather than one per button: a streaming
   * reply re-renders its markdown on every frame, so any listener bound to a
   * button would be thrown away several times a second.
   *
   * The text comes from the rendered <code> element, so what lands on the
   * clipboard is exactly what is on screen — no second escaping pass to get
   * wrong.
   */
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (err) {
      // Denied or unavailable. Fall through to the old way.
    }
    try {
      const pad = document.createElement("textarea");
      pad.value = text;
      pad.setAttribute("readonly", "");
      pad.style.position = "fixed";
      pad.style.opacity = "0";
      document.body.appendChild(pad);
      pad.select();
      const ok = document.execCommand("copy");
      pad.remove();
      return ok;
    } catch (err) {
      return false;
    }
  }

  messagesEl.addEventListener("click", async (event) => {
    const button = event.target.closest && event.target.closest(".code-copy");
    if (!button) return;
    event.preventDefault();
    const block = button.closest(".code-block");
    const code = block && block.querySelector("code");
    if (!code) return;

    const ok = await copyText(code.textContent);
    if (!ok) {
      // Both routes refused — a policy that blocks the clipboard, usually.
      // Selecting the code is the one thing left that makes Ctrl+C work, so
      // do that rather than leave the user with a button that did nothing.
      try {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (err) {
        // Then there is nothing more to offer.
      }
    }
    // The button is still in the document only if the reply is not mid-render.
    if (!button.isConnected) return;
    button.classList.toggle("copied", ok);
    button.innerHTML = ok ? CHECK_ICON : COPY_ICON;
    button.title = ok ? "Copied" : "Selected — press Ctrl+C to copy";
    clearTimeout(button.resetTimer);
    button.resetTimer = setTimeout(() => {
      if (!button.isConnected) return;
      button.classList.remove("copied");
      button.innerHTML = COPY_ICON;
      button.title = "Copy code";
    }, 1600);
  });

  // ---------------------------------------------------------------
  // Message bubbles
  // ---------------------------------------------------------------

  function clearEmptyState() {
    const empty = messagesEl.querySelector(".empty");
    if (empty) empty.remove();
  }

  const atBottom = () =>
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 60;
  const scroll = (was) => {
    if (was) messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  function addBubble(kind, text) {
    clearEmptyState();
    const was = atBottom();
    const node = document.createElement("div");
    node.className = `msg ${kind}`;
    node.textContent = text;
    messagesEl.appendChild(node);
    scroll(was);
    return node;
  }

  /**
   * Both roles run the full width of the one column, so the label above the
   * text is the only thing telling them apart.
   */
  function roleLabel(who) {
    const label = document.createElement("div");
    label.className = "msg-role";
    label.textContent = who;
    return label;
  }

  function addUserBubble(message) {
    clearEmptyState();
    const was = atBottom();
    const node = document.createElement("div");
    node.className = "msg user";
    // No role label here: the block is what says whose turn this is, and a
    // sidebar three inches wide cannot spare a line to repeat it.
    if (message.text) {
      const body = document.createElement("div");
      body.className = "user-text";
      body.textContent = message.text;
      node.appendChild(body);
    }

    // Pictures are shown; everything else is named.
    const shown = (message.attachments || []).filter((a) => a.preview);
    if (shown.length) {
      const strip = document.createElement("div");
      strip.className = "msg-images";
      for (const a of shown) strip.appendChild(thumbnail(a));
      node.appendChild(strip);
    }

    /*
     * The selection stands in for the file it came from, here as in the chip
     * row above the box. A message sent with a highlight used to carry both
     * "media/chat.js" and "media/chat.js:23-27" \u2014 the same file twice, one of
     * them saying strictly less. Only the range survives, and it is named the
     * way the chips are: the file's name, with the path in the tooltip.
     */
    const selected = message.selection
      ? String(message.selection).replace(/:\d+-\d+$/, "")
      : "";
    const tags = [];
    for (const a of message.attachments || []) {
      if (a.preview) continue;
      if (selected && samePathish(a.label, selected)) continue;
      tags.push({ text: `${iconFor(a.kind)} ${fileName(a.label)}`, title: a.label });
    }
    if (message.selection) {
      const range = String(message.selection).slice(selected.length);
      tags.push({ text: `\u2317 ${fileName(selected)}${range}`, title: message.selection });
    }
    if (message.mode && message.mode !== "default") {
      tags.push({ text: `\u25c7 ${message.modeLabel || message.mode}`, title: "" });
    }

    if (tags.length) {
      const meta = document.createElement("div");
      meta.className = "msg-context";
      for (const tag of tags) {
        const item = document.createElement("span");
        item.className = "msg-tag";
        item.textContent = tag.text;
        // The name is what is shown; the whole path is what disambiguates it.
        if (tag.title && tag.title !== tag.text) item.title = tag.title;
        meta.appendChild(item);
      }
      node.appendChild(meta);
    }

    messagesEl.appendChild(node);
    scroll(was);
  }

  /*
   * The steps group: one line saying what is happening, with the detail
   * folded away behind it.
   *
   * A turn can run a dozen tools, and listing them all pushed the answer off
   * the screen before it arrived. The header carries the state — and the
   * elapsed time, which is the thing that tells a slow turn from a stuck one
   * — and the list opens on a click.
   */
  function buildSteps() {
    const steps = document.createElement("div");
    steps.className = "steps";
    steps.hidden = true;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "steps-head";
    head.setAttribute("aria-expanded", "false");

    const icon = document.createElement("span");
    icon.className = "steps-icon";
    icon.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.className = "steps-label";
    const time = document.createElement("span");
    time.className = "steps-time";
    head.append(icon, label, time);

    const list = document.createElement("div");
    list.className = "steps-list";
    list.hidden = true;

    const open = (on) => {
      list.hidden = !on;
      head.setAttribute("aria-expanded", String(on));
      steps.classList.toggle("open", on);
    };
    head.addEventListener("click", () => {
      // Once the user has an opinion, it sticks: the turn ending must not
      // fold up a list they opened on purpose.
      steps.dataset.pinned = "1";
      open(list.hidden);
    });

    steps.append(head, list);
    return { steps, head, icon, label, time, list, open };
  }

  /** "4s", "12s", "1m 05s" — short enough to sit at the end of a line. */
  function elapsedText(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    if (total < 60) return `${total}s`;
    return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, "0")}s`;
  }

  function ensureAgentBubble() {
    if (current) return current;
    clearEmptyState();
    const root = document.createElement("div");
    root.className = "msg agent";
    root.appendChild(roleLabel("Kiro"));
    const group = buildSteps();
    const tools = group.list;
    const body = document.createElement("div");
    // No cursor until there is text to trail: an empty bubble showing a
    // blinking block above "Working…" claims a reply has started when the
    // first token has not arrived. The chunk handler turns it on.
    body.className = "body";
    root.appendChild(group.steps);
    root.appendChild(body);
    messagesEl.appendChild(root);
    current = { root, group, tools, body, toolList: [], startedAt: 0, timer: 0 };
    buffer = "";
    return current;
  }

  /*
   * "Kiro is working on it", in the transcript.
   *
   * The status dot at the very top of the panel was the only sign a turn was
   * running, and it is nowhere near where the answer will appear. Between
   * pressing Send and the first token — which is however long Kiro spends
   * thinking and running tools — the transcript said nothing at all, so a
   * slow turn was indistinguishable from a dead one. This goes in the moment
   * the message is sent and is replaced by the reply itself.
   */
  function startThinking() {
    const was = atBottom();
    const bubble = ensureAgentBubble();
    if (!bubble.startedAt) {
      bubble.startedAt = Date.now();
      bubble.group.steps.hidden = false;
      bubble.group.steps.classList.add("running");
      bubble.group.head.setAttribute("role", "status");
      bubble.group.label.textContent = "Working…";
      // A ticking second is what separates a slow turn from a stuck one.
      const tick = () => {
        if (!bubble.startedAt) return;
        bubble.group.time.textContent = elapsedText(Date.now() - bubble.startedAt);
      };
      tick();
      bubble.timer = setInterval(tick, 1000);
    }
    scroll(was);
    return bubble;
  }

  /**
   * The header says what Kiro is doing right now.
   *
   * "Working…" alone does not answer the question you actually have while
   * waiting, which is *what is it doing* — reading a file, searching, writing
   * one. The newest unfinished step is the answer, and it is the same line the
   * whole list unfolds from, so nothing extra is spent on saying it.
   */
  function updateStepsLabel(bubble) {
    if (!bubble || !bubble.group || !bubble.startedAt) return;
    const steps = bubble.toolList;
    if (steps.length === 0) {
      bubble.group.label.textContent = "Working…";
      bubble.group.head.title = "";
      return;
    }
    const running = [...steps]
      .reverse()
      .find((t) => t.status !== "completed" && t.status !== "failed");
    const step = running || steps[steps.length - 1];
    bubble.group.label.textContent = step.title;
    // The line is ellipsised in a narrow panel, so keep the whole of it here.
    bubble.group.head.title = step.title;
  }

  /**
   * The turn is over. The header stops ticking and becomes a summary of what
   * happened, still folded; the steps are there for anyone who wants them.
   */
  function stopThinking(bubble) {
    const target = bubble || current;
    if (!target || !target.group) return;
    if (target.timer) {
      clearInterval(target.timer);
      target.timer = 0;
    }
    const group = target.group;
    group.steps.classList.remove("running");
    const count = target.toolList.length;
    if (!target.startedAt && count === 0) {
      group.steps.hidden = true;
      return;
    }
    const took = target.startedAt ? Date.now() - target.startedAt : 0;
    target.startedAt = 0;
    /*
     * One sentence once the turn is over: "Completed 2 steps in 7s".
     *
     * While the turn runs the two halves are separate — what it is doing on
     * the left, the clock ticking on the right — but a finished turn is a
     * single fact, and splitting it across the line read as a label with a
     * stray number after it.
     */
    const steps = count === 1 ? "1 step" : `${count} steps`;
    const took_ = took ? ` in ${elapsedText(took)}` : "";
    group.time.textContent = "";

    if (count === 0) {
      /*
       * A turn that ran no steps shows no header at all.
       *
       * There was a second shape for this — a line with the chevron slot
       * standing empty, because there was nothing to unfold — and it sat at a
       * different indent from the ordinary one. Two versions of the same line,
       * neither of them wrong on its own and obviously mismatched together.
       * Dropping it means every header in the transcript has one shape.
       */
      group.steps.hidden = true;
      return;
    }
    // The log of what ran stays on screen for every turn that ran anything.
    // It is folded, and a list the user opened themselves stays open.
    group.steps.hidden = false;
    group.label.textContent = `Completed ${steps}${took_}`;
    // The ticks are welcome now the work has stopped.
    for (const row of group.list.querySelectorAll(".tool")) {
      const seen = target.toolList.find((t) => t.id === row.dataset.id);
      if (seen) renderToolRow(row, seen, "done");
    }
  }

  /**
   * One tool row, drawn the same way live and when a chat is reopened.
   *
   * "Reading chat.js — running" put the state in the same grey prose as the
   * name, so a row that was still going looked like one that had finished.
   * The glyph carries it now, and `data-status` colours it.
   */
  function renderToolRow(row, tool, phase = "live") {
    row.dataset.status = tool.status;
    row.textContent = "";
    const icon = document.createElement("span");
    icon.className = "tool-icon";
    icon.setAttribute("aria-hidden", "true");
    const live = phase === "live";
    const done = tool.status === "completed";
    const failed = tool.status === "failed";
    /*
     * No marks on a finished step.
     *
     * A tick beside every completed row is a column of decoration saying the
     * same thing over and over — of course they finished, the turn is over.
     * The only states worth a glyph are the one still running, which gets the
     * spinner, and a failure, which the row's own colour carries. The slot
     * stays reserved either way so nothing shifts as a step completes.
     */
    icon.textContent = "";
    // A finished turn — or a reopened chat — must not spin over work that
    // stopped long ago.
    if (!done && !failed && live) icon.classList.add("spinning");
    const text = document.createElement("span");
    text.className = "tool-text";
    const title = document.createElement("span");
    title.className = "tool-title";
    title.textContent = tool.title;
    text.appendChild(title);
    // Kiro says why it is doing each step. That is the part worth unfolding
    // for — the title alone only says what, not what for.
    if (tool.purpose) {
      const why = document.createElement("span");
      why.className = "tool-purpose";
      why.textContent = tool.purpose;
      text.appendChild(why);
    }
    row.append(icon, text);
    // The state is a glyph, so say it in words for a screen reader.
    row.setAttribute("aria-label", `${tool.title} — ${tool.status}`);
    return row;
  }

  function addPermissionCard(permission) {
    const was = atBottom();
    const bubble = ensureAgentBubble();
    const card = document.createElement("section");
    card.className = "permission-card";
    card.dataset.requestId = permission.requestId;

    const title = document.createElement("div");
    title.className = "permission-title";
    title.textContent = `Kiro wants to ${permission.title}.`;
    card.appendChild(title);

    const actions = document.createElement("div");
    actions.className = "permission-actions";
    const status = document.createElement("div");
    status.className = "permission-status";

    (permission.options || []).forEach((option, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "permission-option";
      const kind = String(option.kind || "").toLowerCase();
      if (kind.startsWith("allow") || index === 0) button.classList.add("primary");
      if (kind.includes("reject") || kind.includes("deny")) button.classList.add("reject");
      button.textContent = `${index + 1}  ${option.label}`;
      button.addEventListener("click", () => {
        for (const other of actions.querySelectorAll("button")) other.disabled = true;
        button.classList.add("chosen");
        status.textContent = `Selected: ${option.label}`;
        vscode.postMessage({
          type: "permissionDecision",
          requestId: permission.requestId,
          optionId: option.id,
        });
      });
      actions.appendChild(button);
    });

    card.append(actions, status);
    // Never inside the steps list: that folds shut, and a permission the user
    // cannot see is one they cannot answer — the turn would just hang.
    bubble.root.insertBefore(card, bubble.body);
    scroll(was);
  }

  let repaintQueued = false;
  let repaintSticky = false;

  /**
   * Chunks arrive far faster than the screen refreshes, and each one re-renders
   * the whole message. Coalescing them into one paint per frame stops the
   * flicker and the scroll jitter on long replies.
   */
  function scheduleRepaint(stick) {
    repaintSticky = repaintSticky || stick;
    if (repaintQueued) return;
    repaintQueued = true;
    requestAnimationFrame(() => {
      repaintQueued = false;
      const stick = repaintSticky;
      repaintSticky = false;
      if (!current) return;
      current.body.innerHTML = renderMarkdown(buffer);
      scroll(stick);
    });
  }

  function finishAgentBubble() {
    if (current) {
      const timer = current.timer;
      stopThinking(current);
      // Flush whatever the last frame has not painted yet.
      current.body.innerHTML = renderMarkdown(buffer);
      current.body.classList.remove("cursor");
      if (!buffer.trim() && current.tools.children.length === 0) {
        if (timer) clearInterval(timer);
        current.root.remove();
      } else {
        recordAgent(buffer, current.toolList);
      }
    }
    current = null;
    buffer = "";
  }

  // ---------------------------------------------------------------
  // Model menu, with description and credit rate
  // ---------------------------------------------------------------

  function creditsFooter() {
    const foot = document.createElement("div");
    foot.className = "model-foot";

    const line = document.createElement("div");
    if (typeof usage.sessionCredits === "number") {
      line.appendChild(document.createTextNode("This chat has used "));
      const amount = document.createElement("span");
      amount.className = "model-foot-credits";
      amount.textContent = usage.sessionCredits.toFixed(2) + " credits";
      line.appendChild(amount);
      line.appendChild(document.createTextNode("."));
    } else {
      line.textContent = "Kiro has not reported any credit use for this chat yet.";
    }
    foot.appendChild(line);

    if (typeof usage.accountCreditsUsed === "number") {
      const account = document.createElement("div");
      const total =
        typeof usage.accountCreditsLimit === "number"
          ? " of " + usage.accountCreditsLimit
          : "";
      account.textContent =
        (usage.planName || "Your plan") + ": " + usage.accountCreditsUsed + total +
        " credits used" +
        (usage.accountResetsOn ? ", renews " + usage.accountResetsOn : "") + ".";
      foot.appendChild(account);
    }

    if (models.length > 0 && !models.some((m) => m.creditRate)) {
      const note = document.createElement("div");
      note.textContent = "Kiro did not report a per-model credit rate.";
      foot.appendChild(note);
    }

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.textContent = "Check account usage";
    refresh.addEventListener("click", () => {
      closeMenus();
      vscode.postMessage({ type: "refreshUsage" });
    });
    foot.appendChild(refresh);

    return foot;
  }

  function renderModelMenu() {
    modelMenu.innerHTML = "";

    if (models.length === 0) {
      const empty = document.createElement("div");
      empty.className = "model-empty";
      empty.textContent =
        "Kiro did not send a model list, so its own default is in use.";
      modelMenu.appendChild(empty);
    }

    for (const m of models) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "model-row";
      row.setAttribute("role", "option");
      if (m.modelId === currentModelId) row.classList.add("selected");
      row.dataset.modelId = m.modelId;

      const main = document.createElement("div");
      main.className = "model-main";

      const name = document.createElement("div");
      name.className = "model-name";
      name.textContent = m.name;
      main.appendChild(name);

      const detail = [m.description, m.contextWindow].filter(Boolean).join("  ·  ");
      if (detail) {
        const desc = document.createElement("div");
        desc.className = "model-desc";
        desc.textContent = detail;
        main.appendChild(desc);
      }

      row.appendChild(main);

      // Only shown when Kiro actually reports a rate.
      if (m.creditRate) {
        const rate = document.createElement("span");
        rate.className = "model-rate";
        rate.textContent = m.creditRate;
        rate.title = "Credits per request, relative to the base rate";
        row.appendChild(rate);
      }

      modelMenu.appendChild(row);
    }

    modelMenu.appendChild(creditsFooter());
  }

  function setModels(list, currentId) {
    models = list || [];
    currentModelId = currentId || "";
    const active = models.find((m) => m.modelId === currentModelId);
    modelLabel.textContent = active ? active.name : "Default model";
    modelBtn.disabled = busy;
    renderModelMenu();
  }

  function renderModeMenu() {
    modeMenu.innerHTML = "";
    for (const mode of CHAT_MODES) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "mode-row";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", mode.id === currentModeId ? "true" : "false");
      if (mode.id === currentModeId) row.classList.add("selected");
      row.dataset.modeId = mode.id;

      const name = document.createElement("div");
      name.className = "mode-name";
      name.textContent = mode.label;
      row.appendChild(name);

      const desc = document.createElement("div");
      desc.className = "mode-desc";
      desc.textContent = mode.description;
      row.appendChild(desc);
      modeMenu.appendChild(row);
    }
  }

  function setMode(modeId, persist = true) {
    const mode = CHAT_MODES.find((candidate) => candidate.id === modeId) || CHAT_MODES[0];
    currentModeId = mode.id;
    modeLabel.textContent = mode.label;
    modeBtn.title = `${mode.label}: ${mode.description}`;
    renderModeMenu();
    if (persist) saveState();
  }

  function setMenu(menu, button, open) {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeMenus() {
    setMenu(modeMenu, modeBtn, false);
    setMenu(modelMenu, modelBtn, false);
    setMenu(attachMenu, attachBtn, false);
  }

  modeBtn.addEventListener("click", () => {
    const open = modeMenu.hidden;
    closeMenus();
    if (open) renderModeMenu();
    setMenu(modeMenu, modeBtn, open);
  });

  modeMenu.addEventListener("click", (event) => {
    const row = event.target.closest(".mode-row");
    if (!row) return;
    setMode(row.dataset.modeId);
    setMenu(modeMenu, modeBtn, false);
  });

  modelBtn.addEventListener("click", () => {
    const open = modelMenu.hidden;
    closeMenus();
    // Rebuild on the way in so the credits footer is current.
    if (open) renderModelMenu();
    setMenu(modelMenu, modelBtn, open);
  });

  modelMenu.addEventListener("click", (event) => {
    const row = event.target.closest(".model-row");
    if (!row) return;
    setMenu(modelMenu, modelBtn, false);
    vscode.postMessage({ type: "setModel", modelId: row.dataset.modelId });
  });

  // ---------------------------------------------------------------
  // Usage
  // ---------------------------------------------------------------

  // ---------------------------------------------------------------
  // Account usage panel
  //
  // This used to be posted into the conversation as note bubbles, which shoved
  // the chat around and — going through recordSimple — saved the report into
  // the chat history as though the user had asked for it there. It is a panel
  // now: open it, read it, close it, and the transcript never knows.
  // ---------------------------------------------------------------

  function renderUsagePanel() {
    usagePanel.innerHTML = "";

    if (usageLoading) {
      const wait = document.createElement("div");
      wait.className = "usage-loading";
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      const label = document.createElement("span");
      label.textContent = "Asking Kiro for your usage…";
      wait.appendChild(spinner);
      wait.appendChild(label);
      usagePanel.appendChild(wait);
      return;
    }

    const body = document.createElement("div");
    body.className = usageReport && usageReport.ok === false ? "usage-body bad" : "usage-body";
    body.textContent = usageReport
      ? usageReport.text
      : "No account usage fetched yet.";
    usagePanel.appendChild(body);

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "ghost usage-refresh";
    refresh.textContent = usageReport ? "Refresh" : "Check account usage";
    refresh.addEventListener("click", () => {
      usageLoading = true;
      renderUsagePanel();
      vscode.postMessage({ type: "refreshUsage" });
    });
    usagePanel.appendChild(refresh);
  }

  function setUsagePanel(open) {
    usagePanel.hidden = !open;
    usageBar.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) renderUsagePanel();
  }

  function toggleUsagePanel() {
    const opening = usagePanel.hidden;
    closeMenus();
    setUsagePanel(opening);
    // Nothing to read yet, so go and get it rather than showing an empty box.
    if (opening && !usageReport && !usageLoading) {
      usageLoading = true;
      renderUsagePanel();
      vscode.postMessage({ type: "refreshUsage" });
    }
  }

  usageBar.addEventListener("click", toggleUsagePanel);

  function renderUsage(next) {
    usage = next || {};
    const parts = [];

    if (typeof usage.sessionCredits === "number") {
      parts.push(`${usage.sessionCredits.toFixed(2)} credits this chat`);
    }
    if (typeof usage.accountCreditsUsed === "number") {
      const total =
        typeof usage.accountCreditsLimit === "number"
          ? `/${usage.accountCreditsLimit}`
          : "";
      parts.push(`${usage.accountCreditsUsed}${total} credits on ${usage.planName || "your plan"}`);
    }
    if (typeof usage.contextPercent === "number") {
      parts.push(`context ${usage.contextPercent.toFixed(0)}% full`);
      usageFill.style.width = `${Math.min(100, Math.max(0, usage.contextPercent))}%`;
      usageFill.classList.toggle("warn", usage.contextPercent > 80);
    }

    // Credits arrive throughout a turn. Only redraw the list underneath when
    // it is actually on screen; otherwise opening it refreshes it.
    if (!modelMenu.hidden) renderModelMenu();

    usageBar.hidden = parts.length === 0;
    usageText.textContent = parts.join("  \u00b7  ");
    usageBar.title = usage.accountResetsOn
      ? `Plan credits renew ${usage.accountResetsOn}`
      : "";
  }

  // ---------------------------------------------------------------
  // Attachment chips
  // ---------------------------------------------------------------

  function iconFor(kind) {
    if (kind === "folder") return "\u{1F4C1}";
    if (kind === "image") return "\u{1F5BC}";
    return "\u{1F4C4}";
  }

  /**
   * An image attachment shows the picture, not its filename. The extension
   * sends a data URI, which the page's CSP allows; anything too big to be
   * worth sending arrives without one and falls back to the text chip.
   */
  function thumbnail(attachment) {
    if (!attachment.preview) return null;
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = attachment.preview;
    img.alt = attachment.label;
    img.title = attachment.label;
    return img;
  }

  /**
   * Windows writes the same file several ways — drive-letter case, either
   * slash, a trailing separator. Comparing the raw strings would show the same
   * file as two chips. Mirrors samePath() in src/paths.ts, which is what the
   * extension uses to drop the duplicate before sending.
   */
  function samePathish(a, b) {
    if (!a || !b) return false;
    const tidy = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return tidy(a) === tidy(b);
  }

  /**
   * The chip shows the file's name; the whole path lives in its tooltip.
   *
   * A sidebar is narrow, and "media/chat.js:26-26" spent most of that width on
   * a folder the user is already working in. Nothing sent to Kiro changes —
   * it still gets the full path — this is only what is drawn.
   */
  function fileName(pathish) {
    const parts = String(pathish || "").split(/[\\/]/);
    return parts[parts.length - 1] || String(pathish || "");
  }

  function renderChips() {
    chipsEl.innerHTML = "";

    // Already attached by hand, or dragged in? Then the file you are looking
    // at is the same file, and showing it twice is noise — the extension
    // drops the duplicate before sending, so the chip would be lying anyway.
    const activeAlreadyAttached =
      activeFile && attachments.some((a) => samePathish(a.path, activeFile.path));

    /*
     * A selection always comes from the file you are looking at, so while one
     * is being sent the two chips named the same file twice — "chat.js" beside
     * "chat.js:26-26". The narrower one says everything the broader one did,
     * so it stands for both. Switch the selection off and the file chip comes
     * back, because then it is the only thing still going.
     */
    const selectionCoversActiveFile =
      selection && selection.hasSelection && includeSelection;

    // The file on screen comes first: it is the broadest bit of context, and
    // the selection chip below narrows it down.
    if (selectionCoversActiveFile) {
      // Nothing: the selection chip below names the file.
    } else if (activeFile && includeActiveFile && !activeAlreadyAttached) {
      const chip = document.createElement("span");
      chip.className = "chip chip-active";
      chip.title = "Kiro can open " + activeFile.label + ". Click × to leave it out.";

      const label = document.createElement("span");
      label.className = "chip-active-label";
      label.textContent = "◎ " + fileName(activeFile.label);
      chip.appendChild(label);

      const off = document.createElement("button");
      off.type = "button";
      off.className = "chip-x";
      off.textContent = "×";
      off.title = "Do not send this file";
      off.addEventListener("click", () => {
        includeActiveFile = false;
        renderChips();
      });
      chip.appendChild(off);

      chipsEl.appendChild(chip);
    } else if (activeFile && !includeActiveFile && !activeAlreadyAttached) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip chip-muted";
      chip.title = activeFile.label;
      chip.textContent = "◎ add " + fileName(activeFile.label);
      chip.addEventListener("click", () => {
        includeActiveFile = true;
        renderChips();
      });
      chipsEl.appendChild(chip);
    }

    /*
     * The selection chip reports the highlight; it is not a control.
     *
     * It used to carry an \u00d7 that stopped the highlighted code being sent, so
     * the code stayed visibly selected in the editor while the panel had
     * quietly decided not to send it \u2014 two places disagreeing about the same
     * thing, and no way to tell from the editor which was true. The editor
     * owns this: clear the highlight and the chip goes with it.
     */
    if (selectionCoversActiveFile) {
      const chip = document.createElement("span");
      chip.className = "chip chip-selection";
      chip.title =
        "Kiro gets " +
        selection.relativePath +
        " and the highlighted lines. Clear the highlight to stop sending them.";

      // The range is the whole label. A separate "1 line" badge repeated what
      // 26-26 already said.
      const label = document.createElement("span");
      label.textContent = `\u2317 ${fileName(selection.relativePath)}:${selection.startLine}-${selection.endLine}`;
      chip.appendChild(label);

      chipsEl.appendChild(chip);
    }

    for (const a of attachments) {
      const chip = document.createElement("span");
      chip.className = "chip";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "chip-open";
      const thumb = thumbnail(a);
      if (thumb) {
        chip.classList.add("chip-image");
        open.appendChild(thumb);
        const name = document.createElement("span");
        name.textContent = fileName(a.label);
        open.appendChild(name);
      } else {
        open.textContent = `${iconFor(a.kind)} ${fileName(a.label)}`;
      }
      // The full path is what disambiguates two files with the same name.
      open.title = a.path || a.label;
      if (a.path) chip.classList.add("chip-open-able");
      if (a.path) {
        open.addEventListener("click", () =>
          vscode.postMessage({ type: "openFile", path: a.path })
        );
      }
      chip.appendChild(open);

      const x = document.createElement("button");
      x.type = "button";
      x.className = "chip-x";
      x.textContent = "\u00d7";
      x.title = "Remove";
      x.addEventListener("click", () =>
        vscode.postMessage({ type: "removeAttachment", id: a.id })
      );
      chip.appendChild(x);

      chipsEl.appendChild(chip);
    }

    chipsEl.hidden = chipsEl.children.length === 0;
  }

  // ---------------------------------------------------------------
  // Attach menu
  // ---------------------------------------------------------------

  attachBtn.addEventListener("click", () => {
    const open = attachMenu.hidden;
    closeMenus();
    setMenu(attachMenu, attachBtn, open);
  });

  attachMenu.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-act]");
    if (!btn) return;
    setMenu(attachMenu, attachBtn, false);
    vscode.postMessage({ type: btn.dataset.act });
  });

  document.addEventListener("click", (event) => {
    if (!attachBtn.contains(event.target) && !attachMenu.contains(event.target)) {
      setMenu(attachMenu, attachBtn, false);
    }
    if (!modelBtn.contains(event.target) && !modelMenu.contains(event.target)) {
      setMenu(modelMenu, modelBtn, false);
    }
    if (!modeBtn.contains(event.target) && !modeMenu.contains(event.target)) {
      setMenu(modeMenu, modeBtn, false);
    }
    if (!usageBar.contains(event.target) && !usagePanel.contains(event.target)) {
      setUsagePanel(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeMenus();
    setUsagePanel(false);
    // The list takes over the whole panel, so Escape is the way out of it
    // that every other overlay in the editor already teaches.
    if (historyOpen) closeHistory();
  });

  // ---------------------------------------------------------------
  // Paste a screenshot
  // ---------------------------------------------------------------

  inputEl.addEventListener("paste", (event) => {
    const items = (event.clipboardData && event.clipboardData.items) || [];
    for (const item of items) {
      if (item.kind !== "file" || item.type.indexOf("image/") !== 0) continue;
      const file = item.getAsFile();
      if (!file) continue;
      event.preventDefault();

      if (!canSendImages) {
        addBubble("error", "This version of Kiro does not accept images in chat.");
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || "");
        const comma = result.indexOf(",");
        vscode.postMessage({
          type: "pastedImage",
          name: file.name || "screenshot.png",
          mimeType: file.type || "image/png",
          data: comma === -1 ? result : result.slice(comma + 1),
        });
      };
      reader.readAsDataURL(file);
      return;
    }
  });

  // ---------------------------------------------------------------
  // Drag and drop from the Explorer
  // ---------------------------------------------------------------

  let dragDepth = 0;

  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth++;
    dropzone.hidden = false;
    formEl.classList.add("drag-target");
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      dropzone.hidden = true;
      formEl.classList.remove("drag-target");
    }
  });

  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.hidden = true;
    formEl.classList.remove("drag-target");

    const dt = event.dataTransfer;
    if (!dt) return;

    // VS Code offers the same drag under several names at once, and which
    // ones are filled in varies by where the drag came from. Read them all
    // and let the extension work out what was meant; picking one format is
    // how a drop ends up looking as though it did nothing.
    const values = [];
    for (const format of DROP_FORMATS) {
      try {
        const value = dt.getData(format);
        if (value) values.push(value);
      } catch (err) {
        // Some formats throw rather than return empty. Skip them.
      }
    }

    // A drag from outside VS Code — Windows Explorer, a browser — carries
    // real files instead. Images can be attached from their contents; other
    // files only if the host exposes a path.
    const files = dt.files ? Array.from(dt.files) : [];
    for (const file of files) {
      if (file.path) values.push(file.path);
    }
    const images = files.filter((f) => !f.path && /^image\//.test(f.type));
    for (const image of images) attachDroppedImage(image);

    // Always report, even with nothing usable: the types that were on offer
    // are the only way to tell a drop that was not understood from one that
    // never arrived. Kiro Chat: Show Log has it.
    vscode.postMessage({
      type: "dropped",
      values,
      types: dt.types ? Array.from(dt.types) : [],
      fileCount: files.length,
    });
  });

  /** Formats VS Code and the OS use for a dragged file, most specific first. */
  const DROP_FORMATS = [
    "text/uri-list",
    "resourceurls",
    "codefiles",
    "application/vnd.code.uri-list",
    "text/plain",
  ];

  /** A picture dragged in from outside VS Code, which has no path to attach. */
  function attachDroppedImage(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const comma = result.indexOf(",");
      if (comma === -1) return;
      vscode.postMessage({
        type: "pastedImage",
        name: file.name || "dropped image",
        mimeType: file.type || "image/png",
        data: result.slice(comma + 1),
      });
    };
    reader.readAsDataURL(file);
  }

  // ---------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------

  function setBusy(status) {
    busy = status === "busy" || status === "starting";
    // Setup outranks this: a "ready" status arriving mid-setup must not hand
    // the user a live Send button pointing at a Kiro that is not there.
    sendBtn.disabled = busy || setup !== null;
    // Only a reply can be stopped. Offering Stop while Kiro is merely
    // starting up points at a turn that does not exist.
    stopBtn.hidden = status !== "busy";
    modelBtn.disabled = busy;
    modeBtn.disabled = busy;
  }

  /** Put "@src/app.ts" into the message at the caret, so the text refers to it. */
  function insertMentions(labels) {
    if (!labels.length) return;
    const mention = labels.map((l) => "@" + l).join(" ") + " ";
    const start = inputEl.selectionStart != null ? inputEl.selectionStart : inputEl.value.length;
    const end = inputEl.selectionEnd != null ? inputEl.selectionEnd : inputEl.value.length;
    const before = inputEl.value.slice(0, start);
    const after = inputEl.value.slice(end);
    const spacer = before && !/\s$/.test(before) ? " " : "";
    inputEl.value = before + spacer + mention + after;
    const caret = (before + spacer + mention).length;
    inputEl.setSelectionRange(caret, caret);
    inputEl.focus();
    resize();
  }

  function resize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
  }

  function submit() {
    // The Send button is disabled while busy, but Enter bypasses it, which
    // used to start a second turn on top of the running one.
    if (busy) return;
    const text = inputEl.value.trim();
    if (!text && attachments.length === 0) return;
    inputEl.value = "";
    resize();
    vscode.postMessage({
      type: "send",
      text,
      includeSelection,
      includeActiveFile,
      mode: currentModeId,
    });
  }

  formEl.addEventListener("submit", (event) => {
    event.preventDefault();
    submit();
  });

  inputEl.addEventListener("input", resize);

  inputEl.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  });

  stopBtn.addEventListener("click", () => vscode.postMessage({ type: "stop" }));

  // ---------------------------------------------------------------
  // First-run setup screen
  //
  // This screen drives itself. The extension watches for kiro-cli appearing
  // and reports progress through setupState messages; each step shows where
  // it has got to, and once Kiro connects the screen gets out of the way.
  // ---------------------------------------------------------------

  // null when the panel is a normal chat.
  let setup = null;

  const SETUP_STEPS = [
    {
      id: "install",
      title: "Install Kiro",
      detail:
        "Opens PowerShell with the install command typed in. Press Enter to run it — nothing runs on its own.",
      action: "installKiro",
      button: "Install Kiro",
    },
    {
      id: "signin",
      title: "Sign in",
      detail: "Opens PowerShell with the login command. It sends you to your browser.",
      action: "signIn",
      button: "Sign in",
    },
    {
      id: "connect",
      title: "Start chatting",
      detail: "Happens by itself once the two steps above are done.",
      action: "retry",
      button: "Connect now",
    },
  ];

  /** What each watcher state means for each step. */
  const SETUP_PROGRESS = {
    looking: { install: "active", note: "Waiting for kiro-cli to appear…" },
    found: { install: "done", note: null },
    connecting: { install: "done", signin: "active", note: "Connecting to Kiro…" },
    "needs-signin": { install: "done", signin: "todo", note: null },
    connected: { install: "done", signin: "done", connect: "done", note: null },
    "gave-up": { note: null },
  };

  /**
   * `why` says what the box is waiting for. Getting this wrong is how a
   * reconnect ends up telling the user to finish an install they finished
   * days ago.
   */
  function setComposerEnabled(on, why) {
    inputEl.disabled = !on;
    sendBtn.disabled = !on;
    attachBtn.disabled = !on;
    modeBtn.disabled = !on;
    formEl.classList.toggle("composer-locked", !on);
    inputEl.placeholder = on
      ? "Ask Kiro…"
      : why || "Finish setting Kiro up to start chatting";
  }

  function stepNode(step, state, note, primary) {
    const li = document.createElement("li");
    li.className = "step";
    li.dataset.state = state;

    const title = document.createElement("strong");
    title.textContent = step.title;
    li.appendChild(title);

    const detail = document.createElement("p");
    detail.textContent = step.detail;
    li.appendChild(detail);

    // What the panel is doing right now, under what the user is asked to do.
    if (note) {
      const progress = document.createElement("p");
      progress.className = "step-note";
      progress.textContent = note;
      li.appendChild(progress);
    }

    // A finished step keeps its explanation but loses its button; there is
    // nothing left to press. The last step runs itself, so it only offers a
    // button once waiting has actually failed.
    const useless = state === "done" || (step.id === "connect" && state !== "failed");
    if (!useless) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.act = step.action;
      button.textContent = step.button;
      // Exactly one loud button: the thing to do next. Anything else the user
      // could press is there, but quiet, so the eye lands on the right one.
      if (!primary) button.classList.add("ghost");
      li.appendChild(button);
    }

    return li;
  }

  /**
   * Kiro is installed and was working, but this start failed for a reason
   * that is not the login. Say what broke and offer Try again first — the
   * numbered install steps have nothing to do with this.
   */
  function renderFailure(wrap) {
    const heading = document.createElement("h2");
    heading.textContent = "Kiro wouldn't start";
    wrap.appendChild(heading);

    const lead = document.createElement("p");
    lead.textContent =
      "It was working a moment ago, so this is probably temporary. Trying again usually sorts it.";
    wrap.appendChild(lead);

    if (setup.error) {
      const why = document.createElement("p");
      why.className = "setup-error";
      why.textContent = setup.error;
      wrap.appendChild(why);
    }

    const actions = document.createElement("div");
    actions.className = "setup-actions";

    const again = document.createElement("button");
    again.type = "button";
    again.dataset.act = "retry";
    again.textContent = "Try again";
    actions.appendChild(again);

    // Still offered, but demoted: being signed out is only one of the ways
    // this can happen, and it is not the likely one after a restart.
    const signIn = document.createElement("button");
    signIn.type = "button";
    signIn.className = "ghost";
    signIn.dataset.act = "signIn";
    signIn.textContent = "Sign in";
    actions.appendChild(signIn);

    wrap.appendChild(actions);
  }

  function renderSetup() {
    if (!setup) return;
    setComposerEnabled(
      false,
      setup.reason === "failed"
        ? "Kiro isn't connected"
        : "Finish setting Kiro up to start chatting"
    );
    messagesEl.innerHTML = "";
    current = null;
    buffer = "";

    if (setup.reason === "failed") {
      const wrap = document.createElement("div");
      wrap.className = "setup";
      renderFailure(wrap);

      const footer = document.createElement("p");
      footer.className = "hint";
      const log = document.createElement("a");
      log.href = "#";
      log.dataset.act = "showLog";
      log.textContent = "See the full log";
      footer.appendChild(log);
      footer.appendChild(document.createTextNode(" for what was tried."));
      wrap.appendChild(footer);

      wrap.addEventListener("click", (event) => {
        const target = event.target.closest("[data-act]");
        if (!target) return;
        event.preventDefault();
        vscode.postMessage({ type: target.dataset.act });
      });

      messagesEl.appendChild(wrap);
      return;
    }

    const missing = setup.reason === "missing";
    const progress = SETUP_PROGRESS[setup.state] || {};

    const wrap = document.createElement("div");
    wrap.className = "setup";

    const heading = document.createElement("h2");
    heading.textContent = missing ? "Let's get Kiro installed" : "Almost there";
    wrap.appendChild(heading);

    const lead = document.createElement("p");
    lead.textContent = missing
      ? "Kiro's command line tool isn't on this machine yet. That's the part this panel talks to."
      : "Kiro is installed but wouldn't start. Nearly always that means you're not signed in yet.";
    wrap.appendChild(lead);

    const list = document.createElement("ol");
    list.className = "setup-steps";

    let primaryTaken = false;
    for (const step of SETUP_STEPS) {
      // Nothing to install when the binary is already there.
      if (step.id === "install" && !missing) continue;

      let state = progress[step.id] || "todo";
      if (setup.state === "gave-up") state = "failed";

      let note = state === "active" ? progress.note : null;
      if (step.id === "install" && state === "done" && setup.foundAt) {
        note = "Found at " + setup.foundAt;
      }
      if (step.id === "signin" && setup.error && state !== "done") {
        note = "Kiro would not start: " + setup.error;
      }

      // The first unfinished step is the one to shout about.
      const primary = !primaryTaken && state !== "done";
      if (primary) primaryTaken = true;

      list.appendChild(stepNode(step, state, note, primary));
    }

    wrap.appendChild(list);

    // Watching has a time limit, so say so rather than looking like it is
    // still working when it has quietly stopped.
    if (setup.state === "gave-up") {
      const detail = document.createElement("p");
      detail.className = "setup-detail";
      detail.textContent =
        "Stopped watching for Kiro. Press Connect once it is installed and you are signed in.";
      wrap.appendChild(detail);
    }

    const footer = document.createElement("p");
    footer.className = "hint";
    const copy = document.createElement("a");
    copy.href = "#";
    copy.dataset.act = "copyCommand";
    copy.textContent = "Copy the install command";
    const log = document.createElement("a");
    log.href = "#";
    log.dataset.act = "showLog";
    log.textContent = "see what was tried";
    const settings = document.createElement("a");
    settings.href = "#";
    settings.dataset.act = "openSettings";
    settings.textContent = "set the path yourself";

    footer.appendChild(document.createTextNode("Rather do it yourself? "));
    if (missing) {
      footer.appendChild(copy);
      footer.appendChild(document.createTextNode(", "));
    }
    footer.appendChild(log);
    footer.appendChild(document.createTextNode(" or "));
    footer.appendChild(settings);
    footer.appendChild(document.createTextNode("."));
    wrap.appendChild(footer);

    wrap.addEventListener("click", (event) => {
      const target = event.target.closest("[data-act]");
      if (!target) return;
      event.preventDefault();
      vscode.postMessage({ type: target.dataset.act });
    });

    messagesEl.appendChild(wrap);
  }

  function showSetup(reason, detail) {
    setup = {
      reason,
      state: reason === "missing" ? "looking" : "needs-signin",
      note: null,
      error: reason === "missing" ? null : detail,
    };
    renderSetup();
  }

  /**
   * Kiro is starting. Show it in the transcript rather than only in the status
   * line, so a restart looks like it is working instead of looking like
   * nothing is happening until a screen appears.
   */
  function showConnecting() {
    if (setup) return; // the setup screen has more to say than a spinner
    setComposerEnabled(false, "Connecting to Kiro…");
    messagesEl.innerHTML = "";
    current = null;
    buffer = "";

    const wrap = document.createElement("div");
    wrap.className = "connecting";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    const label = document.createElement("span");
    label.textContent = "Connecting to Kiro…";
    wrap.appendChild(spinner);
    wrap.appendChild(label);
    messagesEl.appendChild(wrap);
  }

  function clearConnecting() {
    const node = messagesEl.querySelector(".connecting");
    if (node) node.remove();
    if (!setup) setComposerEnabled(true);
  }

  /**
   * Put the setup screen away and hand the panel back to the chat. Called for
   * the watcher's own "connected", and for any other route that gets Kiro
   * running — pressing Connect, or a restart from the title bar — because
   * those never send a setup message at all.
   */
  function leaveSetup() {
    if (!setup) return;
    setup = null;
    setComposerEnabled(true);
    messagesEl.innerHTML = "";
    messagesEl.appendChild(emptyState());
  }

  /** Progress from the watcher. "connected" hands the panel back to the chat. */
  function updateSetup(state, detail) {
    if (!setup) return;
    if (state === "connected") {
      leaveSetup();
      return;
    }
    setup.state = state;
    // Where it was found stays on screen for the rest of setup: it is the
    // proof that the install worked, and the answer to "did it even see it?".
    if (state === "found") setup.foundAt = detail;
    // Why it would not start. Worth showing — "not signed in" is only the
    // usual cause, not the only one.
    if (state === "needs-signin") setup.error = detail;
    renderSetup();
  }

  // ---------------------------------------------------------------
  // Past chats
  //
  // The list takes over the transcript area rather than opening a dialog, so
  // it works wherever the panel is docked. Nothing is thrown away to show it:
  // going back puts the conversation straight back on screen.
  // ---------------------------------------------------------------

  // Two separate things: the list the extension last sent, and whether it is
  // on screen. Folding them into one variable meant going back to the chat
  // threw the list away, so reopening it showed "no past chats".
  let historyData = null;
  let historyOpen = false;
  /** What the user has typed into the filter box. */
  let historyQuery = "";

  function matchesQuery(chat, query) {
    if (!query) return true;
    const hay = (chat.title + " " + (chat.preview || "")).toLowerCase();
    return hay.indexOf(query) >= 0;
  }

  function renderHistory() {
    if (!historyOpen) return;
    const view = historyData || { groups: [] };
    messagesEl.innerHTML = "";
    current = null;

    const wrap = document.createElement("div");
    wrap.className = "history";

    const bar = document.createElement("div");
    bar.className = "history-bar";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "linkish";
    back.dataset.act = "back";
    back.textContent = "‹ Back to chat";
    bar.appendChild(back);
    wrap.appendChild(bar);

    const allGroups = view.groups || [];
    const query = historyQuery.trim().toLowerCase();
    const groups = allGroups
      .map((group) => ({
        label: group.label,
        chats: (group.chats || []).filter((chat) => matchesQuery(chat, query)),
      }))
      .filter((group) => group.chats.length > 0);

    const total = allGroups.reduce((sum, g) => sum + (g.chats || []).length, 0);
    // A filter box over three chats is clutter; over fifty it is the only way
    // through, because the titles repeat.
    if (total > 5) {
      const search = document.createElement("input");
      search.type = "search";
      search.className = "history-search";
      search.placeholder = "Search past chats";
      search.value = historyQuery;
      search.setAttribute("aria-label", "Search past chats");
      search.addEventListener("input", () => {
        historyQuery = search.value;
        const at = search.selectionStart;
        renderHistory();
        // Redrawing replaces the box, so put the caret back where it was.
        const next = messagesEl.querySelector(".history-search");
        if (next) {
          next.focus();
          try {
            next.setSelectionRange(at, at);
          } catch (err) {
            // Some input types refuse a selection range. Focus is enough.
          }
        }
      });
      wrap.appendChild(search);
    }

    if (allGroups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent =
        "No past chats in this folder yet. They are saved as you talk.";
      wrap.appendChild(empty);
    } else if (groups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent = "No chat here matches “" + historyQuery.trim() + "”.";
      wrap.appendChild(empty);
    }

    for (const group of groups) {
      const heading = document.createElement("div");
      heading.className = "history-day";
      heading.textContent = group.label;
      wrap.appendChild(heading);

      for (const chat of group.chats) {
        const row = document.createElement("div");
        row.className = "history-row";
        if (chat.id === view.openId) row.classList.add("current");

        const open = document.createElement("button");
        open.type = "button";
        open.className = "history-open";
        open.dataset.act = "open";
        open.dataset.id = chat.id;

        const title = document.createElement("div");
        title.className = "history-title";
        title.textContent = chat.title;
        open.appendChild(title);

        // Chats open with whatever was on the user's mind, so titles repeat.
        // The newest line is what tells two otherwise identical rows apart.
        if (chat.preview && chat.preview !== chat.title) {
          const preview = document.createElement("div");
          preview.className = "history-preview";
          preview.textContent = chat.preview;
          open.appendChild(preview);
        }

        const meta = document.createElement("div");
        meta.className = "history-meta";
        const count = chat.messageCount === 1 ? "1 message" : chat.messageCount + " messages";
        meta.textContent = count + " · " + chat.at;
        // A chat Kiro cannot reopen can still be read, so say which it is
        // rather than letting the user find out by trying to reply.
        if (!chat.resumable || !view.canResume) {
          meta.textContent += " · read only";
        }
        open.appendChild(meta);

        row.appendChild(open);

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "history-delete";
        remove.dataset.act = "delete";
        remove.dataset.id = chat.id;
        remove.textContent = "×";
        remove.title = "Forget this chat";
        remove.setAttribute("aria-label", "Forget “" + chat.title + "”");
        row.appendChild(remove);

        wrap.appendChild(row);
      }
    }

    wrap.addEventListener("click", (event) => {
      const target = event.target.closest("[data-act]");
      if (!target) return;
      event.preventDefault();
      const act = target.dataset.act;
      if (act === "back") {
        closeHistory();
      } else if (act === "open") {
        vscode.postMessage({ type: "openChat", id: target.dataset.id });
      } else if (act === "delete") {
        vscode.postMessage({ type: "deleteChat", id: target.dataset.id });
      }
    });

    messagesEl.appendChild(wrap);
  }

  function openHistory() {
    if (setup) return; // setup has more to say than an empty list
    historyOpen = true;
    historyQuery = "";
    setComposerEnabled(false, "Pick a chat, or go back");
    renderHistory();
    // Draw whatever we already have, then ask for the current list rather
    // than showing a stale one.
    vscode.postMessage({ type: "requestHistory" });
  }

  /** Put the conversation back exactly as it was. */
  function closeHistory() {
    historyOpen = false;
    setComposerEnabled(true);
    messagesEl.innerHTML = "";
    if (history.length > 0) restoreHistory(history);
    else messagesEl.appendChild(emptyState());
  }

  // ---------------------------------------------------------------
  // Keep or undo, pinned above the message box
  //
  // This sits outside the transcript on purpose. It appears the moment the
  // inline diff opens, so both routes are available at the same time: decide
  // each hunk in the diff, or take the whole lot from here. Inside the
  // transcript it would scroll away exactly when it is needed.
  // ---------------------------------------------------------------

  const changeBar = el("change-bar");
  /** The review currently on screen, if any. */
  let pendingReview = null;
  /** What the last finished turn changed, if it has not been answered yet. */
  let pendingChanges = null;

  function renderChangeBar() {
    const review = pendingReview;
    const changes = pendingChanges;
    if (!review && !changes) {
      changeBar.hidden = true;
      changeBar.innerHTML = "";
      return;
    }

    changeBar.innerHTML = "";
    changeBar.hidden = false;

    // While a review is open the summary is itself the way through the
    // changes, the way a merge conflict is walked: click it and the editor
    // goes to a change, click it again and it goes to the next one. A separate
    // button for that was a third thing competing with the two decisions.
    const summary = document.createElement(review ? "button" : "div");
    summary.className = "change-summary";
    if (review) {
      const left = Math.max(0, review.hunks - review.decided);
      const name = review.path.split(/[\\/]/).pop();
      summary.type = "button";
      summary.title = "Show this change in the editor. Click again for the next one.";
      summary.textContent =
        left === 1
          ? `Reviewing ${name} — 1 change left`
          : `Reviewing ${name} — ${left} changes left`;
      const hint = document.createElement("span");
      hint.className = "change-jump";
      hint.textContent = "›";
      summary.appendChild(hint);
      summary.addEventListener("click", () => {
        vscode.postMessage({ type: "gotoChange" });
      });
    } else {
      summary.textContent = changes.text || "Kiro changed some files.";
    }
    changeBar.appendChild(summary);

    // Naming them matters: "3 files" is not something you can agree to.
    if (!review && changes.files.length > 1) {
      const list = document.createElement("ul");
      list.className = "change-files";
      for (const file of changes.files) {
        const item = document.createElement("li");
        item.dataset.kind = file.kind;
        item.textContent = file.label || file.path;
        list.appendChild(item);
      }
      changeBar.appendChild(list);
    }

    const actions = document.createElement("div");
    actions.className = "change-actions";

    const keep = document.createElement("button");
    keep.type = "button";
    keep.textContent = "Keep all changes";
    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "ghost";
    undo.textContent = review ? "Reject all changes" : "Undo all changes";

    const settle = () => {
      keep.disabled = true;
      undo.disabled = true;
    };
    keep.addEventListener("click", () => {
      settle();
      vscode.postMessage({ type: "keepChanges" });
      pendingReview = null;
      pendingChanges = null;
      renderChangeBar();
    });
    undo.addEventListener("click", () => {
      settle();
      vscode.postMessage({ type: "undoChanges" });
    });

    actions.appendChild(keep);
    actions.appendChild(undo);
    changeBar.appendChild(actions);
  }

  // ---------------------------------------------------------------
  // Messages from the extension
  // ---------------------------------------------------------------

  const STATUS_TEXT = {
    stopped: "Not connected",
    starting: "Starting Kiro\u2026",
    ready: "Ready",
    busy: "Kiro is working\u2026",
  };

  window.addEventListener("message", (event) => {
    const message = event.data;
    switch (message.type) {
      case "status":
        statusEl.dataset.state = message.status;
        statusEl.textContent = STATUS_TEXT[message.status] || message.status;
        // Kiro is up. However that happened, the instructions for getting it
        // up have nothing left to say.
        if (message.status === "ready") {
          leaveSetup();
          clearConnecting();
        }
        if (message.status === "starting") showConnecting();
        setBusy(message.status);
        break;

      case "capabilities":
        canSendImages = Boolean(message.caps && message.caps.image);
        break;

      case "models":
        setModels(message.models, message.currentModelId);
        break;

      case "usage":
        renderUsage(message.usage || {});
        break;

      case "usageReportLoading":
        usageLoading = true;
        if (!usagePanel.hidden) renderUsagePanel();
        break;

      case "usageReport":
        usageLoading = false;
        usageReport = { text: message.text, ok: message.ok !== false };
        // A refresh asked for from the model menu should show its answer.
        setUsagePanel(true);
        break;

      case "toggleUsage":
        toggleUsagePanel();
        break;

      case "selection": {
        selection = message.selection || null;

        // Switching to a different file brings the chip back. Dismissing it
        // means "not this one", not "never again".
        const next = message.activeFile || null;
        const changed = (next && next.path) !== (activeFile && activeFile.path);
        activeFile = next;
        if (changed) includeActiveFile = true;

        renderChips();
        break;
      }

      case "defaults":
        // The setting decides this on its own now. The chip reports the
        // highlight rather than switching it off, so there is no per-message
        // choice left for a restored panel to protect.
        if (typeof message.sendSelection === "boolean") {
          includeSelection = message.sendSelection;
          renderChips();
        }
        break;

      case "attachments":
        attachments = message.attachments || [];
        renderChips();
        break;

      case "userMessage":
        finishAgentBubble();
        addUserBubble(message);
        recordUser(message);
        // Kiro has the turn now. Say so where the answer will appear, rather
        // than only on the status line at the top of the panel.
        startThinking();
        break;

      case "chunk": {
        const was = atBottom();
        const bubble = ensureAgentBubble();
        // The reply itself has arrived, so it replaces "Working…".
        buffer += message.text;
        // A bare blinking block with nothing before it is not a reply. The
        // "Working…" header stays until real text has arrived.
        bubble.body.classList.toggle("cursor", Boolean(buffer.trim()));
        scheduleRepaint(was);
        break;
      }

      case "tool": {
        const was = atBottom();
        const bubble = ensureAgentBubble();
        const id = "tool-" + message.tool.id;
        let row = bubble.tools.querySelector(`[data-id="${CSS.escape(id)}"]`);
        if (!row) {
          row = document.createElement("div");
          row.className = "tool";
          row.dataset.id = id;
          bubble.tools.appendChild(row);
        }
        // A tool can arrive by a route that never posted a userMessage, so
        // the header is started here too rather than assumed to be running.
        startThinking();
        renderToolRow(row, message.tool, "live");
        const seen = bubble.toolList.find((t) => t.id === id);
        if (seen) {
          seen.title = message.tool.title;
          seen.status = message.tool.status;
          // A later update carries the real title and the purpose; the first
          // notification has only the kind.
          if (message.tool.purpose) seen.purpose = message.tool.purpose;
        } else {
          bubble.toolList.push({
            id,
            title: message.tool.title,
            status: message.tool.status,
            purpose: message.tool.purpose,
          });
        }
        /*
         * A step arrived, so the header exists — always, and unconditionally.
         *
         * It used to be revealed as a side effect of `startThinking`, which
         * does nothing once the clock is already running, so the one thing
         * guaranteeing the log was visible was a call that had usually
         * already happened. Setting it here means a step can never be
         * recorded without somewhere to see it.
         *
         * The list itself stays folded: the header names the step being run,
         * which is the live answer to "what is it doing", and the rest is one
         * click away for whoever wants it.
         */
        bubble.group.steps.hidden = false;
        updateStepsLabel(bubble);
        scroll(was);
        break;
      }

      case "permission":
        addPermissionCard(message.permission || {});
        break;

      case "turnEnd":
        finishAgentBubble();
        break;

      case "reviewActive":
        // Offered the moment the diff opens, so the whole file can be taken
        // or dropped without walking every hunk.
        pendingReview = message.review || null;
        renderChangeBar();
        break;

      case "turnChanges":
        finishAgentBubble();
        pendingChanges = { text: message.text, files: message.files || [] };
        renderChangeBar();
        break;

      case "changesUndone":
        pendingReview = null;
        pendingChanges = null;
        renderChangeBar();
        addBubble(
          "note",
          message.restored === 1
            ? "Put 1 file back as it was."
            : `Put ${message.restored} files back as they were.`
        );
        break;

      case "error":
        finishAgentBubble();
        addBubble("error", message.text);
        recordSimple("error", message.text);
        break;

      case "needsSetup":
        showSetup(message.reason, message.detail);
        break;

      case "setupState":
        updateSetup(message.state, message.detail);
        break;

      case "cleared":
        pendingReview = null;
        pendingChanges = null;
        renderChangeBar();
        messagesEl.innerHTML = "";
        current = null;
        buffer = "";
        history = [];
        historyTruncated = false;
        saveState();
        renderUsage({});
        // Starting a new session while Kiro is still missing must not throw
        // away the instructions for installing it.
        if (setup) renderSetup();
        else messagesEl.appendChild(emptyState());
        break;

      case "insertMentions":
        insertMentions(message.labels || []);
        break;

      case "history":
        historyData = message;
        if (historyOpen) renderHistory();
        break;

      case "showHistory":
        openHistory();
        break;

      case "openChat":
        // The transcript comes back from the extension's copy, which outlives
        // this panel. Kiro is told to reload the session separately.
        historyOpen = false;
        setComposerEnabled(true);
        // The other chat's pending edits are not this chat's to answer.
        pendingReview = null;
        pendingChanges = null;
        renderChangeBar();
        history = message.history || [];
        historyTruncated = message.truncated === true;
        current = null;
        buffer = "";
        // Reported back, this would re-save the record we were just handed.
        saveState(false);
        messagesEl.innerHTML = "";
        if (history.length > 0) restoreHistory(history);
        else messagesEl.appendChild(emptyState());
        break;

      case "chatReadOnly":
        // Kiro could not take the conversation back, so replying would start
        // a different one without saying so. Say so instead.
        setComposerEnabled(false, "This chat can only be read");
        addBubble("note", message.why + "\n\nStart a new chat with + to keep talking.");
        break;
    }
  });

  // ---------------------------------------------------------------
  // Startup: restore a moved panel, or open a fresh chat
  // ---------------------------------------------------------------

  function emptyState() {
    const wrap = document.createElement("div");
    wrap.className = "empty";
    const line = document.createElement("p");
    line.textContent = "Ask Kiro about your code.";
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = "Enter sends, Shift+Enter starts a new line. Hold Shift and drag files here to attach them, or paste a screenshot.";
    wrap.appendChild(line);
    wrap.appendChild(hint);
    return wrap;
  }

  function restoreHistory(saved) {
    messagesEl.innerHTML = "";
    // Only the tail of a long chat is kept. Saying so beats letting the user
    // wonder why the conversation appears to start in the middle.
    if (historyTruncated) {
      const note = document.createElement("div");
      note.className = "history-trimmed";
      note.textContent = "Earlier messages in this chat are no longer stored.";
      messagesEl.appendChild(note);
    }
    for (const item of saved) {
      if (item.role === "user") {
        addUserBubble(item);
      } else if (item.role === "agent") {
        const bubble = ensureAgentBubble();
        const steps = item.tools || [];
        for (const tool of steps) {
          const row = document.createElement("div");
          row.className = "tool";
          renderToolRow(row, tool, "restored");
          bubble.tools.appendChild(row);
        }
        if (steps.length > 0) {
          // Folded, like a turn that has just finished. There is no timing to
          // show for a chat reopened from storage.
          bubble.group.steps.hidden = false;
          // No timing survives in a stored chat, so the sentence stops short.
          bubble.group.label.textContent =
            steps.length === 1 ? "Completed 1 step" : `Completed ${steps.length} steps`;
        }
        buffer = item.text || "";
        bubble.body.innerHTML = renderMarkdown(buffer);
        bubble.body.classList.remove("cursor");
        current = null;
        buffer = "";
      } else {
        addBubble(item.role, item.text);
      }
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const saved = (() => {
    try {
      return vscode.getState() || {};
    } catch (err) {
      return {};
    }
  })();

  if (CHAT_MODES.some((mode) => mode.id === saved.mode)) {
    currentModeId = saved.mode;
  }
  // Rendering restored state must not call saveState before the transcript
  // below has itself been restored, or a panel move can overwrite it empty.
  setMode(currentModeId, false);

  let restored = false;
  if (Array.isArray(saved.history) && saved.history.length > 0) {
    history = saved.history;
    historyTruncated = saved.historyTruncated === true;
    // `includeSelection` is not restored: it is the setting's to decide, and
    // the `defaults` message that follows `ready` carries the current value.
    restoreHistory(history);
    restored = true;
  }

  renderChips();
  vscode.postMessage({ type: "ready", restored });
})();
