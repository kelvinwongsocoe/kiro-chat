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
  const usageBar = el("usage-bar");
  const usageFill = el("usage-fill");
  const usageText = el("usage-text");
  const usagePanel = el("usage-panel");
  const dropzone = el("dropzone");

  let current = null;
  let buffer = "";
  let models = [];
  let currentModelId = "";
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

  function saveState() {
    try {
      vscode.setState({ history: history.slice(-MAX_HISTORY), includeSelection });
    } catch (err) {
      // State is a convenience. Never let it break the panel.
    }
    // Webview state dies with the panel, so hand the same transcript to the
    // extension, which can keep it in the chat history. This fires per turn,
    // not per chunk, so it is not chatty.
    try {
      vscode.postMessage({ type: "transcript", history: history.slice(-MAX_HISTORY) });
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
    node.appendChild(roleLabel("You"));

    if (message.text) {
      const body = document.createElement("div");
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

    const tags = [];
    for (const a of message.attachments || []) {
      if (!a.preview) tags.push(`${iconFor(a.kind)} ${a.label}`);
    }
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
    root.appendChild(roleLabel("Kiro"));
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

  function renderChips() {
    chipsEl.innerHTML = "";

    // Already attached by hand, or dragged in? Then the file you are looking
    // at is the same file, and showing it twice is noise — the extension
    // drops the duplicate before sending, so the chip would be lying anyway.
    const activeAlreadyAttached =
      activeFile && attachments.some((a) => samePathish(a.path, activeFile.path));

    // The file on screen comes first: it is the broadest bit of context, and
    // the selection chip below narrows it down.
    if (activeFile && includeActiveFile && !activeAlreadyAttached) {
      const chip = document.createElement("span");
      chip.className = "chip chip-active";
      chip.title = "Kiro can open " + activeFile.label + ". Click × to leave it out.";

      const label = document.createElement("span");
      label.className = "chip-active-label";
      label.textContent = "◎ " + activeFile.label;
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
      chip.textContent = "◎ add " + activeFile.label;
      chip.addEventListener("click", () => {
        includeActiveFile = true;
        renderChips();
      });
      chipsEl.appendChild(chip);
    }

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
      const thumb = thumbnail(a);
      if (thumb) {
        chip.classList.add("chip-image");
        open.appendChild(thumb);
        const name = document.createElement("span");
        name.textContent = a.label;
        open.appendChild(name);
      } else {
        open.textContent = `${iconFor(a.kind)} ${a.label}`;
      }
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
    if (!usageBar.contains(event.target) && !usagePanel.contains(event.target)) {
      setUsagePanel(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenus();
      setUsagePanel(false);
    }
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
    vscode.postMessage({ type: "send", text, includeSelection, includeActiveFile });
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

    const groups = view.groups || [];
    if (groups.length === 0) {
      const empty = document.createElement("p");
      empty.className = "history-empty";
      empty.textContent =
        "No past chats in this folder yet. They are saved as you talk.";
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
        remove.className = "chip-x history-delete";
        remove.dataset.act = "delete";
        remove.dataset.id = chat.id;
        remove.textContent = "×";
        remove.title = "Forget this chat";
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
    setComposerEnabled(false, "Pick a chat, or go back");
    renderHistory();
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
        if (!selection) includeSelection = true;

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
        // Seeds the highlighted-code toggle from settings, unless a moved
        // panel already restored the user's own choice.
        if (typeof message.sendSelection === "boolean" && !restoredChoice) {
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
        showSetup(message.reason, message.detail);
        break;

      case "setupState":
        updateSetup(message.state, message.detail);
        break;

      case "cleared":
        messagesEl.innerHTML = "";
        current = null;
        buffer = "";
        history = [];
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
        history = message.history || [];
        current = null;
        buffer = "";
        saveState();
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

  // True when a moved panel restored the user’s own toggle, so the setting
  // default must not overwrite it.
  let restoredChoice = false;
  let restored = false;
  if (Array.isArray(saved.history) && saved.history.length > 0) {
    history = saved.history;
    if (typeof saved.includeSelection === "boolean") {
      includeSelection = saved.includeSelection;
      restoredChoice = true;
    }
    restoreHistory(history);
    restored = true;
  }

  renderChips();
  vscode.postMessage({ type: "ready", restored });
})();
