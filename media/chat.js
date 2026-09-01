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
  const modelBtn = el("model-btn");
  const modelLabel = el("model-label");
  const modelMenu = el("model-menu");
  const usageBtn = el("usage-btn");
  const usageBar = el("usage-bar");
  const usageFill = el("usage-fill");
  const usageText = el("usage-text");
  const dropzone = el("dropzone");

  let current = null;
  let buffer = "";
  let models = [];
  let currentModelId = "";
  let attachments = [];
  let selection = null;
  let includeSelection = true;
  let canSendImages = false;
  let busy = false;
  let usage = {};
  let usageNote = null;

  // VS Code destroys and rebuilds this script whenever the view is moved
  // between the sidebar, the panel or the secondary sidebar. Anything we
  // want to survive that has to live in webview state.
  let history = [];
  const MAX_HISTORY = 120;

  function saveState() {
    try {
      vscode.setState({ history: history.slice(-MAX_HISTORY), includeSelection });
    } catch (err) {
      // State is a convenience. Never let it break the panel.
    }
  }

  function recordUser(message) {
    history.push({
      role: "user",
      text: message.text || "",
      attachments: message.attachments || [],
      selection: message.selection,
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

  function renderMarkdown(source) {
    const blocks = [];
    const withoutCode = source.replace(/```([\w-]*)\n?([\s\S]*?)(?:```|$)/g, (_, lang, code) => {
      const index = blocks.length;
      blocks.push(
        `<pre><code class="language-${escapeHtml(lang || "text")}">${escapeHtml(
          code.replace(/\n$/, "")
        )}</code></pre>`
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

  function addUserBubble(message) {
    clearEmptyState();
    const was = atBottom();
    const node = document.createElement("div");
    node.className = "msg user";

    if (message.text) {
      const body = document.createElement("div");
      body.textContent = message.text;
      node.appendChild(body);
    }

    const tags = [];
    for (const a of message.attachments || []) tags.push(`${iconFor(a.kind)} ${a.label}`);
    if (message.selection) tags.push(`\u2317 ${message.selection}`);

    if (tags.length) {
      const meta = document.createElement("div");
      meta.className = "msg-context";
      meta.textContent = tags.join("   ");
      node.appendChild(meta);
    }

    messagesEl.appendChild(node);
    scroll(was);
  }

  function ensureAgentBubble() {
    if (current) return current;
    clearEmptyState();
    const root = document.createElement("div");
    root.className = "msg agent";
    const tools = document.createElement("div");
    tools.className = "tools";
    const body = document.createElement("div");
    body.className = "body cursor";
    root.appendChild(tools);
    root.appendChild(body);
    messagesEl.appendChild(root);
    current = { root, tools, body, toolList: [] };
    buffer = "";
    return current;
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
      // Flush whatever the last frame has not painted yet.
      current.body.innerHTML = renderMarkdown(buffer);
      current.body.classList.remove("cursor");
      if (!buffer.trim() && current.tools.children.length === 0) {
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

  function setMenu(menu, button, open) {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", open ? "true" : "false");
  }

  function closeMenus() {
    setMenu(modelMenu, modelBtn, false);
    setMenu(attachMenu, attachBtn, false);
  }

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

  usageBtn.addEventListener("click", () => vscode.postMessage({ type: "refreshUsage" }));

  // ---------------------------------------------------------------
  // Attachment chips
  // ---------------------------------------------------------------

  function iconFor(kind) {
    if (kind === "folder") return "\u{1F4C1}";
    if (kind === "image") return "\u{1F5BC}";
    return "\u{1F4C4}";
  }

  function renderChips() {
    chipsEl.innerHTML = "";

    if (selection && selection.hasSelection && includeSelection) {
      const chip = document.createElement("span");
      chip.className = "chip chip-selection";
      chip.title = "The code you have highlighted goes with your message. Click to stop sending it.";

      const label = document.createElement("span");
      label.textContent = `\u2317 ${selection.relativePath}:${selection.startLine}-${selection.endLine}`;
      chip.appendChild(label);

      const count = document.createElement("span");
      count.className = "chip-count";
      count.textContent = `${selection.lineCount} ${selection.lineCount === 1 ? "line" : "lines"}`;
      chip.appendChild(count);

      const off = document.createElement("button");
      off.type = "button";
      off.className = "chip-x";
      off.textContent = "\u00d7";
      off.title = "Do not send the highlighted code";
      off.addEventListener("click", () => {
        includeSelection = false;
        renderChips();
      });
      chip.appendChild(off);

      chipsEl.appendChild(chip);
    } else if (selection && selection.hasSelection && !includeSelection) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip chip-muted";
      chip.textContent = `\u2317 add ${selection.relativePath}:${selection.startLine}-${selection.endLine}`;
      chip.addEventListener("click", () => {
        includeSelection = true;
        renderChips();
      });
      chipsEl.appendChild(chip);
    }

    for (const a of attachments) {
      const chip = document.createElement("span");
      chip.className = "chip";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "chip-open";
      open.textContent = `${iconFor(a.kind)} ${a.label}`;
      open.title = a.path || a.label;
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
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenus();
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

    // VS Code's Explorer offers dragged items as a uri-list.
    const uriList = dt.getData("text/uri-list") || dt.getData("resourceurls") || "";
    let uris = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));

    // resourceurls arrives as a JSON array of encoded strings.
    if (uris.length === 1 && uris[0].startsWith("[")) {
      try {
        uris = JSON.parse(uris[0]).map((u) => decodeURIComponent(String(u)));
      } catch (err) {
        // Leave the single entry as-is.
      }
    }

    if (uris.length === 0) {
      const plain = dt.getData("text/plain").trim();
      if (plain) uris = [plain];
    }

    if (uris.length > 0) vscode.postMessage({ type: "dropped", uris });
  });

  // ---------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------

  function setBusy(value) {
    busy = value;
    sendBtn.disabled = value;
    stopBtn.hidden = !value;
    modelBtn.disabled = value;
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
    vscode.postMessage({ type: "send", text, includeSelection });
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
  // ---------------------------------------------------------------

  function stepRow(title, detail, buttonLabel, action) {
    const li = document.createElement("li");
    const h = document.createElement("strong");
    h.textContent = title;
    const p = document.createElement("p");
    p.textContent = detail;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = buttonLabel;
    b.dataset.act = action;
    li.appendChild(h);
    li.appendChild(p);
    li.appendChild(b);
    return li;
  }

  function showSetup(reason, platform) {
    messagesEl.innerHTML = "";
    current = null;
    buffer = "";

    const isWindows = platform === "win32";
    const missing = reason === "missing";
    const wrap = document.createElement("div");
    wrap.className = "setup";
    wrap.innerHTML =
      "<h2>" +
      escapeHtml(missing ? "One more thing to install" : "Almost there") +
      "</h2><p>" +
      escapeHtml(
        missing
          ? "Kiro's command line tool is not on this machine yet. That is the part this panel talks to."
          : "Kiro is installed but would not start. Nearly always this means you are not signed in yet."
      ) +
      "</p>";

    const steps = document.createElement("ol");
    steps.className = "setup-steps";

    if (missing) {
      steps.appendChild(
        stepRow(
          "Install Kiro",
          isWindows
            ? "Opens PowerShell and types the install command. Press Enter to run it."
            : "Opens a terminal and types the install command. Press Enter to run it.",
          "Install Kiro",
          "installKiro"
        )
      );
    }
    steps.appendChild(
      stepRow(
        "Sign in",
        "Opens a terminal with the login command. It will send you to your browser.",
        "Sign in",
        "signIn"
      )
    );
    steps.appendChild(
      stepRow("Come back here", "Once that finishes, connect.", "Connect", "retry")
    );
    wrap.appendChild(steps);

    const footer = document.createElement("p");
    footer.className = "hint";
    footer.innerHTML =
      'Still stuck? <a href="#" data-act="showLog">See what was tried</a> or ' +
      '<a href="#" data-act="openSettings">set the path yourself</a>.';
    wrap.appendChild(footer);

    wrap.addEventListener("click", (event) => {
      const target = event.target.closest("[data-act]");
      if (!target) return;
      event.preventDefault();
      vscode.postMessage({ type: target.dataset.act });
    });

    messagesEl.appendChild(wrap);
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
        setBusy(message.status === "busy" || message.status === "starting");
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
        finishAgentBubble();
        if (usageNote) usageNote.remove();
        usageNote = addBubble("note", "Asking Kiro for your usage\u2026");
        break;

      case "usageReport": {
        finishAgentBubble();
        if (usageNote) {
          usageNote.remove();
          usageNote = null;
        }
        const kind = message.ok ? "note" : "error";
        addBubble(kind, message.text);
        recordSimple(kind, message.text);
        break;
      }

      case "selection":
        selection = message.selection || null;
        if (!selection) includeSelection = true;
        renderChips();
        break;

      case "attachments":
        attachments = message.attachments || [];
        renderChips();
        break;

      case "userMessage":
        finishAgentBubble();
        addUserBubble(message);
        recordUser(message);
        break;

      case "chunk": {
        const was = atBottom();
        const bubble = ensureAgentBubble();
        buffer += message.text;
        bubble.body.classList.add("cursor");
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
        row.dataset.status = message.tool.status;
        row.textContent = `${message.tool.title} \u2014 ${message.tool.status}`;
        const seen = bubble.toolList.find((t) => t.id === id);
        if (seen) {
          seen.title = message.tool.title;
          seen.status = message.tool.status;
        } else {
          bubble.toolList.push({ id, title: message.tool.title, status: message.tool.status });
        }
        scroll(was);
        break;
      }

      case "turnEnd":
        finishAgentBubble();
        break;

      case "error":
        finishAgentBubble();
        addBubble("error", message.text);
        recordSimple("error", message.text);
        break;

      case "needsSetup":
        showSetup(message.reason, message.platform);
        break;

      case "cleared":
        messagesEl.innerHTML = "";
        messagesEl.appendChild(emptyState());
        current = null;
        buffer = "";
        history = [];
        usageNote = null;
        saveState();
        renderUsage({});
        break;

      case "insertMentions":
        insertMentions(message.labels || []);
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
    hint.textContent = "Drop files on the box below, paste a screenshot, or just start typing.";
    wrap.appendChild(line);
    wrap.appendChild(hint);
    return wrap;
  }

  function restoreHistory(saved) {
    messagesEl.innerHTML = "";
    for (const item of saved) {
      if (item.role === "user") {
        addUserBubble(item);
      } else if (item.role === "agent") {
        const bubble = ensureAgentBubble();
        for (const tool of item.tools || []) {
          const row = document.createElement("div");
          row.className = "tool";
          row.dataset.status = tool.status;
          row.textContent = `${tool.title} \u2014 ${tool.status}`;
          bubble.tools.appendChild(row);
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

  let restored = false;
  if (Array.isArray(saved.history) && saved.history.length > 0) {
    history = saved.history;
    if (typeof saved.includeSelection === "boolean") includeSelection = saved.includeSelection;
    restoreHistory(history);
    restored = true;
  }

  renderChips();
  vscode.postMessage({ type: "ready", restored });
})();
