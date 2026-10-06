// HyperExecute Studio — webview UI (vanilla JS).
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (sel, el = document) => el.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const md = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  const send = (type, extra = {}) => vscode.postMessage({ type, ...extra });

  let S = null; // latest state from the extension
  let busyLabel = null;
  let activeTab = "validation";
  let dryRun = null;

  const LOGO = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z" fill="currentColor"/></svg>`;

  document.getElementById("app").innerHTML = `
    <header class="top">
      <div class="repo">
        <select id="repoSel" aria-label="Repository"></select>
        <button class="icon-btn" id="reanalyze" title="Re-analyze repo">↻</button>
        <button class="sdot" id="backendPill"><span class="dot"></span><span>AI</span></button>
        <button class="sdot" id="kbPill"><span class="dot"></span><span>KB</span></button>
        <div class="menu-wrap">
          <button class="icon-btn" id="moreBtn" title="More actions" aria-haspopup="menu" aria-expanded="false">⋯</button>
          <div class="menu" id="moreMenu" role="menu" hidden>
            <button role="menuitem" data-act="backend">Choose AI backend…</button>
            <button role="menuitem" data-act="kb">Connect Confluence…</button>
            <button role="menuitem" data-act="publish">Add to Confluence (document this setup)</button>
            <hr>
            <button role="menuitem" data-act="clearChat">Clear chat</button>
            <button role="menuitem" data-act="updates">Check for updates</button>
          </div>
        </div>
      </div>
    </header>
    <div class="journey" id="journey"></div>
    <nav class="main-tabs" role="tablist">
      <button class="mtab" role="tab" data-pane="chat">Chat</button>
      <button class="mtab" role="tab" data-pane="yaml">YAML <span class="n" id="yamlBadge"></span></button>
      <button class="mtab" role="tab" data-pane="grid">Grid</button>
      <button class="mtab" role="tab" data-pane="runs">Runs <span class="n" id="runsBadge"></span></button>
      <button class="mtab" role="tab" data-pane="setup">Setup <span class="n" id="setupBadge"></span></button>
    </nav>
    <section class="pane" data-pane="chat">
      <button class="stackline" id="stackline" title="Show detected stack and options"></button>
      <div class="log" id="log"></div>
      <div class="chips" id="chips"></div>
      <div class="composer">
        <textarea id="input" rows="2" placeholder="Describe what the customer needs — OS, VMs, split, browsers, tags, tunnel…" aria-label="Instruction"></textarea>
        <div class="composer-row"><span class="muted small" id="hint">Enter to send · Shift+Enter for new line</span><button class="btn primary" id="sendBtn">Send</button></div>
      </div>
    </section>
    <section class="pane" data-pane="yaml">
      <div class="optbar" id="opts"></div>
      <div class="yaml-h"><span id="yamlTitle">hyperexecute.yaml</span><span class="badge-v" id="verBadge"></span><span class="edited" id="edited"></span><span class="spacer"></span><button class="link-btn" id="maskBtn" hidden></button><span class="muted small" id="lines"></span></div>
      <div id="genError"></div>
      <div class="editor"><div class="gutter" id="gutter">1</div><div class="code-wrap"><pre class="hl" id="hl" aria-hidden="true"></pre><textarea id="yaml" spellcheck="false" aria-label="Generated YAML"></textarea></div></div>
      <div class="actions">
        <button class="btn" id="save">Save to repo</button>
        <button class="btn" id="run" title="Save, then run the job on HyperExecute and watch it in the Runs tab">▶ Run</button>
        <span class="spacer"></span>
        <div class="menu-wrap up">
          <button class="btn ghost" id="yamlMore" title="More" aria-haspopup="menu" aria-expanded="false">⋯</button>
          <div class="menu" id="yamlMenu" role="menu" hidden>
            <button role="menuitem" id="openEd">Open in editor</button>
            <button role="menuitem" id="copy">Copy</button>
            <button role="menuitem" id="dry">Dry-run discovery</button>
            <button role="menuitem" id="optimize">Optimize</button>
            <button role="menuitem" id="annotatedMenu">Open annotated copy</button>
          </div>
        </div>
      </div>
      <div class="checks">
        <div class="tabs" role="tablist">
          <button class="tab" role="tab" data-tab="validation">Checks<span class="n" id="nVal"></span></button>
          <button class="tab" role="tab" data-tab="discovery">Discovery</button>
          <button class="tab" role="tab" data-tab="optimize">Optimize<span class="n" id="nOpt"></span></button>
          <button class="tab" role="tab" data-tab="explain" title="What every line of this YAML does">Explain</button>
        </div>
        <div class="panel" id="checks"></div>
      </div>
    </section>
    <section class="pane scroll" data-pane="grid">
      <div class="card"><div class="card-h">Where this repo connects</div><div class="card-b" id="driverSetup"><span class="muted small">Loading…</span></div></div>
      <div class="card"><div class="card-h">Capabilities<span class="spacer"></span><span class="muted small" id="capsLive"></span></div><div class="card-b"><div class="form" id="capsForm"></div></div></div>
      <div class="card"><div class="card-h">What to change</div><div class="card-b" id="capsChanges"></div>
        <div class="card-b small muted" id="capsNotes"></div></div>
    </section>
    <section class="pane" data-pane="runs">
      <div class="run-bar">
        <button class="btn primary" id="runStart">▶ Run &amp; watch</button>
        <button class="btn ghost" id="runStop" disabled>Stop</button>
        <span class="spacer"></span>
        <button class="icon-btn small" id="runOpenLog" title="Open the full log in the Output panel">Full log</button>
      </div>
      <div class="run-opts"><label class="toggle tight"><input type="checkbox" id="runAuto"> Auto-fix &amp; rerun</label><label class="small muted">max <select id="runMax"><option>1</option><option>2</option><option selected>3</option><option>4</option><option>5</option></select> attempts</label></div>
      <div class="run-status" id="runStatus"></div>
      <pre class="runlog" id="runLog"></pre>
      <div class="run-diag" id="runDiag"></div>
    </section>
    <section class="pane scroll" data-pane="setup">
      <div class="card"><div class="card-h">LambdaTest account<span class="spacer"></span><span id="ltState" class="small"></span></div>
        <div class="card-b stack-gap">
          <div class="field"><label for="ltUser">Username</label><input type="text" id="ltUser" autocomplete="off" spellcheck="false"></div>
          <div class="field"><label for="ltKey">Access key</label><input type="password" id="ltKey" autocomplete="off"></div>
          <div class="row"><button class="btn primary" id="ltSave">Save &amp; test</button><button class="btn ghost" id="ltTest">Test</button><button class="btn ghost" id="ltClear">Remove</button></div>
          <label class="toggle tight"><input type="checkbox" id="ltEmbed"> Put my username &amp; key into generated YAMLs</label>
          <div class="small muted" id="ltEmbedNote"></div>
          <div class="small muted">Used by ▶ Run to trigger jobs. The key is kept in VS Code's encrypted secret storage.</div>
        </div></div>
      <div class="card"><div class="card-h">Credentials &amp; reporting<span class="spacer"></span><button class="icon-btn small" id="rescan">Rescan</button></div><div class="card-b" id="scan"></div></div>
      <div class="card"><div class="card-h">Detected stack<span class="spacer"></span><span id="fileState" class="muted small"></span></div><div class="card-b" id="stack"></div></div>
    </section>
    <div id="busy"></div><div id="toast" role="status"></div>`;

  let pane = "chat";
  const showPane = (p) => {
    pane = p;
    document.querySelectorAll(".pane").forEach((el) => el.classList.toggle("active", el.dataset.pane === p));
    document.querySelectorAll(".mtab").forEach((el) => { el.classList.toggle("active", el.dataset.pane === p); el.setAttribute("aria-selected", el.dataset.pane === p); });
    if (p === "yaml") updateGutter();
  };
  document.querySelectorAll(".mtab").forEach((t) => (t.onclick = () => showPane(t.dataset.pane)));
  $("#stackline").onclick = () => showPane("setup");

  // ---------- events ----------
  $("#repoSel").onchange = (e) => send("selectRepo", { path: e.target.value });
  $("#reanalyze").onclick = () => send("reanalyze");
  $("#backendPill").onclick = () => send("command", { id: "hyperexecute.chooseBackend" });
  $("#kbPill").onclick = () => send("command", { id: "hyperexecute.setAtlassianToken" });

  // small dropdown menus (header ⋯ and the YAML ⋯); one open at a time, closed by any outside click or Escape
  const menus = [["#moreBtn", "#moreMenu"], ["#yamlMore", "#yamlMenu"]];
  const closeMenus = () => menus.forEach(([b, m]) => { $(m).hidden = true; $(b).setAttribute("aria-expanded", "false"); });
  for (const [b, m] of menus) {
    $(b).onclick = (e) => { e.stopPropagation(); const open = $(m).hidden; closeMenus(); $(m).hidden = !open; $(b).setAttribute("aria-expanded", String(open)); if (open) $(m).querySelector("button")?.focus(); };
    $(m).addEventListener("click", () => closeMenus());
  }
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });
  const ACTS = {
    backend: () => send("command", { id: "hyperexecute.chooseBackend" }),
    kb: () => send("command", { id: "hyperexecute.setAtlassianToken" }),
    publish: () => send("publishConfluence"),
    clearChat: () => send("clearChat"),
    updates: () => send("command", { id: "hyperexecute.checkForUpdates" }),
  };
  $("#moreMenu").querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => ACTS[b.dataset.act]()));

  $("#save").onclick = () => send("save");
  $("#openEd").onclick = () => send("openInEditor");
  $("#copy").onclick = () => send("copy");
  $("#annotatedMenu").onclick = () => send("openAnnotated");
  $("#dry").onclick = () => { activeTab = "discovery"; send("dryRun"); renderChecks(); };
  showPane("chat");
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => { activeTab = t.dataset.tab; renderChecks(); }));

  const input = $("#input");
  const submit = () => {
    const text = input.value.trim();
    if (busyLabel && busyLabel.startsWith("Thinking")) return send("cancel");
    if (!text) return;
    input.value = "";
    autosize();
    send("chat", { text });
  };
  $("#sendBtn").onclick = submit;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(140, input.scrollHeight) + "px"; };
  input.addEventListener("input", autosize);

  const ta = $("#yaml");
  let editTimer;
  ta.addEventListener("input", () => {
    updateGutter();
    clearTimeout(editTimer);
    editTimer = setTimeout(() => send("yamlEdited", { yaml: ta.value }), 350);
  });
  ta.addEventListener("scroll", () => { $("#gutter").scrollTop = ta.scrollTop; $("#hl").scrollTop = ta.scrollTop; $("#hl").scrollLeft = ta.scrollLeft; });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); document.execCommand("insertText", false, "  "); }
  });
  // the access key is shown as dots unless the user asks to see it (the text itself is unchanged)
  let showKey = false;
  $("#maskBtn").onclick = () => { showKey = !showKey; updateGutter(); };
  function updateGutter() {
    const n = ta.value.split("\n").length;
    $("#gutter").textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
    $("#lines").textContent = `${n} lines`;
    const hasKey = /^\s*LT_ACCESS_KEY:\s*(?!\$\{\{)\S/m.test(ta.value);
    $("#maskBtn").hidden = !hasKey;
    $("#maskBtn").textContent = showKey ? "Hide key" : "Show key";
    $("#hl").innerHTML = highlightYaml(ta.value, { maskKey: hasKey && !showKey });
    $("#hl").scrollTop = ta.scrollTop;
  }

  // YAML colouring for the editor overlay (same rules as the web version's highlighter)
  function highlightYaml(text, { maskKey } = {}) {
    const h = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
    const value = (v) => !v ? "" : h(v)
      .replace(/(&lt;set [^&]*&gt;)/g, '<span class="t-todo">$1</span>')
      .replace(/(\$\{\{[^}]*\}\})/g, '<span class="t-secret">$1</span>')
      .replace(/(^|[\s"'=:])(\$[A-Za-z_][\w]*|\$\{[^}]+\})/g, '$1<span class="t-var">$2</span>')
      .replace(/^(\s*)(true|false|null|yes|no)(\s*)$/i, '$1<span class="t-bool">$2</span>$3')
      .replace(/^(\s*)(-?\d+(?:\.\d+)?)(\s*)$/, '$1<span class="t-num">$2</span>$3')
      .replace(/^(\s*)(["'])(.*)\2(\s*)$/, '$1<span class="t-str">$2$3$2</span>$4');
    const line = (l) => {
      if (/^\s*#/.test(l) || /^---\s*$/.test(l)) return `<span class="t-comment">${h(l)}</span>`;
      const k = l.match(/^(\s*LT_ACCESS_KEY:\s*)(\S.*)$/);
      if (maskKey && k && !k[2].startsWith("${{")) return `${h(k[1]).replace("LT_ACCESS_KEY", '<span class="t-key">LT_ACCESS_KEY</span>')}<span class="t-secret">${"•".repeat(k[2].length)}</span>`;
      const m = l.match(/^(\s*)(- )?([\w.$/-]+)(:)(\s|$)(.*)$/);
      if (m) {
        const [, ind, dash = "", key, colon, sp, rest] = m;
        const hash = rest.match(/^(.*?)(\s+#.*)$/);
        return `${ind}${dash ? '<span class="t-dash">- </span>' : ""}<span class="t-key">${h(key)}</span><span class="t-punct">${colon}</span>${sp}${value(hash ? hash[1] : rest)}${hash ? `<span class="t-comment">${h(hash[2])}</span>` : ""}`;
      }
      const li = l.match(/^(\s*)(- )(.*)$/);
      return li ? `${li[1]}<span class="t-dash">- </span>${value(li[3])}` : value(l);
    };
    return text.split("\n").map(line).join("\n") + "\n";
  }

  // ---------- rendering ----------
  function render() {
    if (!S) return;
    renderTop();
    renderJourney();
    renderStack();
    renderOptions();
    renderChat();
    renderYaml();
    renderChecks();
  }

  function renderTop() {
    const sel = $("#repoSel");
    sel.innerHTML = S.repos.length ? S.repos.map((r) => `<option value="${esc(r.path)}" ${r.path === S.repo ? "selected" : ""}>${esc(r.name)}</option>`).join("") : `<option>Open a folder in VS Code to begin</option>`;
    const m = S.meta || {};
    const bp = $("#backendPill");
    bp.children[0].className = "dot " + (m.backendId === "rules" ? "off" : "on");
    bp.title = `AI: ${m.backend || "…"}${m.backendId === "rules" ? " (no AI model; click to choose one)" : ""}. Click to change.`;
    const kp = $("#kbPill");
    kp.children[0].className = "dot " + (m.confluence ? "on" : "off");
    kp.title = m.confluence ? `Knowledge base: Confluence ${m.confluenceSpace} connected${m.confluenceTeam ? " (shared team access)" : ""}` : "Knowledge base: bundled notes only. Click to connect Confluence.";
    $('#moreMenu [data-act="publish"]').hidden = !m.publishEnabled;
    $('#moreMenu [data-act="kb"]').textContent = m.confluence ? `Confluence: ${m.confluenceSpace} (change…)` : "Connect Confluence…";
    $('#moreMenu [data-act="backend"]').textContent = `AI: ${m.backend || "…"} (change…)`;
  }

  // Where the user is: Analyzed → Valid → Saved → Ran → Passed, and the one thing to do next.
  function journey() {
    const v = S.validation, r = S.run, m = S.meta || {};
    const errs = v?.errors?.length || 0;
    const steps = [
      ["Analyzed", !!S.profile],
      ["Valid", !!v && !errs],
      ["Saved", S.onDisk === "same"],
      ["Ran", !!r?.history?.length],
      ["Passed", r?.status === "passed"],
    ];
    let next;
    if (!S.repos?.length) next = { label: "Open a folder", hint: "Open your test repo in VS Code", act: () => send("command", { id: "workbench.action.files.openFolder" }) };
    else if (!S.profile) next = { label: "Analyze", hint: "Analyze this repo", act: () => send("reanalyze") };
    else if (errs) next = { label: `Fix ${errs} error${errs > 1 ? "s" : ""}`, hint: "The YAML has problems", act: () => { showPane("yaml"); activeTab = "validation"; renderChecks(); } };
    else if (S.onDisk !== "same") next = { label: "Save to repo", hint: S.onDisk === "different" ? "The repo's file differs from this YAML" : "Not saved in the repo yet", act: () => send("save") };
    else if (!m.ltReady) next = { label: "Add account", hint: "Add your LambdaTest account to run", act: () => showPane("setup") };
    else if (r?.status === "running") next = { label: "Watch", hint: `Run ${r.attempt} in progress`, act: () => showPane("runs") };
    else if (!r?.history?.length) next = { label: "▶ Run", hint: "Ready to run on HyperExecute", act: () => { showPane("runs"); $("#runStart").click(); } };
    else if (r.status !== "passed") next = { label: "See why", hint: "The last run didn't pass", act: () => showPane("runs") };
    else next = { label: "Set up CI", hint: "Passed. Run it from your CI next?", act: () => { showPane("chat"); send("chat", { text: "Create a CI pipeline for this YAML" }); } };
    return { steps, next };
  }
  let nextAct = null;
  function renderJourney() {
    const { steps, next } = journey();
    const firstOpen = steps.findIndex(([, done]) => !done);
    $("#journey").innerHTML =
      `<ol class="steps">${steps.map(([label, done], i) => `<li class="${done ? "done" : i === firstOpen ? "now" : ""}" title="${label}${done ? " ✓" : ""}"><span class="mark">${done ? "✓" : i + 1}</span><span class="lbl">${label}</span></li>`).join("")}</ol>` +
      `<div class="next"><span class="hint">${esc(next.hint)}</span><button class="btn primary small" id="nextBtn">${esc(next.label)}</button></div>`;
    nextAct = next.act;
    $("#nextBtn").onclick = () => nextAct?.();
    // the action bar follows the same order: the next step is the primary button
    const saveNext = S.onDisk !== "same";
    $("#save").className = "btn" + (saveNext ? " primary" : "");
    $("#run").className = "btn" + (!saveNext ? " primary" : "");
  }

  function renderStackLine() {
    const p = S.profile, r = S.result || {};
    const el = $("#stackline");
    if (!p) { el.innerHTML = `<span class="muted">Open a folder with test code to begin</span>`; return; }
    const t = p.tests;
    const count = t.scenarioCount ? `${t.scenarioCount} scenarios` : t.methodCount ? `${t.methodCount} tests` : t.fileCount ? `${t.fileCount} spec files` : t.classCount ? `${t.classCount} classes` : "no tests found";
    el.innerHTML = `<span class="tag">${esc(r.framework || p.language || "?")}</span><span>${esc([p.language, p.buildTool || p.packageManager].filter(Boolean).join(" · "))} · ${count}${r.yamlVersion ? " · YAML v" + r.yamlVersion : ""}</span>${S.scan?.credentials?.length ? `<span class="warn-n bad" title="Hard-coded credentials">🔑 ${S.scan.credentials.length}</span>` : ""}${p.warnings?.length ? `<span class="warn-n">⚠ ${p.warnings.length}</span>` : ""}${p.confidence && p.confidence.level !== "high" ? `<span class="conf ${esc(p.confidence.level)}" title="${esc((p.confidence.reasons || []).join("; "))}">${p.questions?.length ? `${p.questions.length} to confirm` : `${esc(p.confidence.level)} confidence`}</span>` : ""}<span class="chev">›</span>`;
  }

  function renderStack() {
    renderStackLine();
    const el = $("#stack");
    const p = S.profile;
    if (!p) { el.innerHTML = `<div class="muted small">Open a workspace folder with test automation code.</div>`; return; }
    const r = S.result || {};
    const t = p.tests;
    const stats = [
      ["classes", t.classCount], ["methods", t.methodCount], ["spec files", t.fileCount],
      ["features", t.featureCount], ["scenarios", t.scenarioCount], ["test funcs", t.functionCount],
    ].filter(([, n]) => n);
    const w = [...(p.warnings || [])];
    el.innerHTML = `
      <div class="stack-row">
        ${r.framework ? `<span class="tag">${esc(r.framework)}</span>` : ""}
        ${p.language ? `<span class="tag soft">${esc(p.language)}${p.runtimeVersion ? " " + esc(p.runtimeVersion) : ""}</span>` : ""}
        ${p.buildTool || p.packageManager ? `<span class="tag soft">${esc(p.buildTool || p.packageManager)}</span>` : ""}
        ${(p.drivers || []).map((d) => `<span class="tag soft">${esc(d)}</span>`).join("")}
        ${p.grid?.usesLambdaTestHub ? `<span class="tag soft">LambdaTest hub</span>` : ""}
      </div>
      <div class="stats">${stats.map(([k, n]) => `<div class="stat"><b>${n}</b><span>${k}</span></div>`).join("") || `<span class="muted small">No tests detected</span>`}</div>
      ${t.tags?.length ? `<div class="small muted" style="margin-top:8px">Tags: ${t.tags.slice(0, 8).map(esc).join(", ")}</div>` : ""}
      ${w.length ? `<details class="warn"><summary>⚠ ${w.length} thing${w.length > 1 ? "s" : ""} to check</summary><ul>${w.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
      ${confidenceBlock(p)}`;
    el.querySelectorAll("button.answer").forEach((b) => (b.onclick = () => { showPane("chat"); input.value = b.dataset.q + "\n→ "; autosize(); input.focus(); }));
    $("#fileState").textContent = S.existingFile ? `${S.existingFile} exists in repo` : "";
  }

  // What the analysis is unsure about: confidence, what it assumed, and what to ask before generating.
  function confidenceBlock(p) {
    const c = p.confidence;
    if (!c) return "";
    const a = p.assumptions || [];
    const q = p.questions || [];
    if (c.level === "high" && !a.length && !q.length) return `<div class="conf-box high"><span class="conf high">high confidence</span></div>`;
    return `<div class="conf-box ${esc(c.level)}">
      <div class="conf-h"><span class="conf ${esc(c.level)}">${esc(c.level)} confidence</span>${c.reasons?.length ? `<span class="small muted">${esc(c.reasons.join("; "))}</span>` : ""}</div>
      ${q.length ? `<div class="conf-sub">Confirm with the customer</div><ul class="qs">${q.map((x) => `<li><span>${esc(x)}</span><button class="btn ghost small answer" data-q="${esc(x)}" title="Answer in chat">Answer</button></li>`).join("")}</ul>` : ""}
      ${a.length ? `<div class="conf-sub">Assumed</div><ul class="as">${a.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    </div>`;
  }

  let moreOpen = false;
  function renderOptions() {
    const el = $("#opts");
    const o = S.options || {};
    const r = S.result || {};
    const splits = r.supportedSplits || ["class"];
    if (!S.profile) return (el.innerHTML = "");
    // keep focus and a half-typed number while the YAML regenerates
    const focused = document.activeElement?.id;
    const sel = (id, label, opts, val) =>
      `<label class="f" for="${id}"><span>${label}</span><select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
    const num = (id, label, val, min, max) => `<label class="f" for="${id}"><span>${label}</span><input type="number" id="${id}" value="${esc(val)}" min="${min}" max="${max}"></label>`;
    const retries = o.retryOnFailure === false ? 0 : o.maxRetries ?? 1;
    // the four everyday options always show; the rest sit behind "More"
    el.innerHTML =
      `<div class="optrow">` +
      sel("o-os", "OS", [["linux", "Linux"], ["win", "Windows"], ["win11", "Win 11"], ["mac", "macOS"], ["mac13", "macOS 13"]], o.runson || "linux") +
      num("o-conc", "VMs", o.concurrency ?? 5, 1, 500) +
      sel("o-split", "Split by", splits.map((s) => [s, s[0].toUpperCase() + s.slice(1)]), o.splitBy || r.splitBy || splits[0]) +
      num("o-retry", "Retries", retries, 0, 5) +
      `</div><div class="optline"><label class="toggle tight"><input type="checkbox" id="o-tunnel" ${o.tunnel ? "checked" : ""}> Tunnel</label><span class="spacer"></span><button class="link-btn" id="moreOptsBtn" aria-expanded="${moreOpen}">${moreOpen ? "Fewer options ▴" : "More options ▾"}</button></div>` +
      `<div class="more-opts"${moreOpen ? "" : " hidden"}><div class="optrow">` +
      sel("o-ver", "YAML", [["auto", `Auto (${r.yamlVersion ? "v" + r.yamlVersion : "…"})`], ["0.2", "v0.2 native"], ["0.1", "v0.1 raw"]], o.yamlVersion || "auto") +
      sel("o-mode", "Mode", [["autosplit", "Autosplit"], ["matrix", "Matrix"]], o.executionMode || r.executionMode || "autosplit") +
      num("o-timeout", "Timeout (min)", o.globalTimeout ?? 90, 1, 150) +
      (S.profile?.mavenProfiles?.length ? sel("o-mvnp", "Maven profile", [["", "None"], ...S.profile.mavenProfiles.map((m) => [m.id, m.id + (m.activeByDefault ? " (default)" : "")])], o.mavenProfile || "") : "") +
      `</div><button class="link-btn" id="resetOpts" title="Back to the detected defaults">Reset to detected defaults</button></div>`;
    $("#moreOptsBtn").onclick = () => { moreOpen = !moreOpen; renderOptions(); };
    $("#resetOpts").onclick = () => send("resetOptions");
    if (focused && $("#" + focused)) $("#" + focused).focus();
    const push = (options) => send("setOptions", { options });
    $("#o-ver").onchange = (e) => push({ yamlVersion: e.target.value === "auto" ? null : e.target.value });
    $("#o-os").onchange = (e) => push({ runson: e.target.value });
    $("#o-mode").onchange = (e) => push({ executionMode: e.target.value, yamlVersion: e.target.value === "matrix" ? "0.1" : o.yamlVersion });
    $("#o-split").onchange = (e) => push({ splitBy: e.target.value });
    $("#o-tunnel").onchange = (e) => push({ tunnel: e.target.checked || null });
    if ($("#o-mvnp")) $("#o-mvnp").onchange = (e) => push({ mavenProfile: e.target.value || null });
    const debounced = (fn) => { let t; return (e) => { clearTimeout(t); t = setTimeout(() => fn(e), 500); }; };
    $("#o-conc").oninput = debounced((e) => +e.target.value >= 1 && push({ concurrency: +e.target.value }));
    $("#o-retry").oninput = debounced((e) => { const n = +e.target.value; push(n > 0 ? { retryOnFailure: true, maxRetries: Math.min(5, n) } : { retryOnFailure: false, maxRetries: null }); });
    $("#o-timeout").oninput = debounced((e) => +e.target.value >= 1 && push({ globalTimeout: Math.min(150, +e.target.value) }));
  }

  function suggestions() {
    const p = S.profile;
    if (!p) return [];
    const r = S.result || {};
    const s = ["Run on Windows 11 with 10 VMs", "Add a tunnel for our staging site"];
    if (r.supportedSplits?.includes("scenario")) s.push("Split by scenario");
    else if (r.supportedSplits?.includes("method")) s.push("Split by method");
    if (p.tests.tags?.length) s.push(`Only run ${p.tests.tags.slice(0, 2).join(" and ")}`);
    s.push("Cross-browser: Chrome and Firefox");
    if (r.yamlVersion === "0.2") s.push("Why v0.2 and not v0.1?");
    s.push("Optimize this YAML");
    if (S.scan?.credentials?.length || S.scan?.reporting?.length) s.unshift("What reports to the customer's side?");
    s.push("Fail fast after 3 failures");
    s.push("Explain this YAML line by line");
    return s.slice(0, 6);
  }

  // What a chat turn changed: validation after it, each option with why it matters, and the YAML diff.
  const openDiffs = new Set();
  function changeBlock(m) {
    const ch = m.change;
    if (!ch) return "";
    const k = ch.check;
    const check = !k ? "" : k.valid
      ? `<div class="ck ok">✓ Valid${k.warnings ? ` · ${k.warnings} warning(s)` : ""}</div>`
      : `<div class="ck bad">✕ ${k.errors.length + k.moreErrors} validation error(s)<ul>${k.errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>${ch.undone ? "" : `<button class="chip fix-errors" data-errors="${esc(k.errors.join("\n"))}">Fix these errors</button>`}</div>`;
    const why = ch.changes.length
      ? `<ul class="why">${ch.changes.map((c) => `<li><code>${esc(c.key)}</code>${c.from !== undefined ? ` <span class="from">${esc(c.from)}</span> → <b>${esc(c.to)}</b>` : ""}${c.why ? `<div class="muted">${esc(c.why)}</div>` : ""}</li>`).join("")}</ul>`
      : "";
    const d = ch.diff;
    const diff = d && (d.added || d.removed)
      ? `<details class="diff" data-id="${ch.id}"${openDiffs.has(ch.id) ? " open" : ""}><summary>YAML diff <span class="add">+${d.added}</span> <span class="del">−${d.removed}</span></summary><pre>${d.lines.map((l) => `<span class="${l.op === "+" ? "add" : l.op === "-" ? "del" : l.op === "…" ? "gap" : ""}">${l.op === "…" ? "  ⋯" : esc(l.op + " " + l.text)}</span>`).join("\n")}${d.truncated ? "\n  ⋯ (open the YAML tab for the rest)" : ""}</pre></details>`
      : "";
    return `<div class="change${ch.undone ? " undone" : ""}">${why}${diff}${ch.undone ? "" : check}</div>`;
  }

  function renderChat() {
    const log = $("#log");
    const msgs = S.chat || [];
    const talk = msgs.filter((m) => m.role !== "event"); // timeline lines don't count as conversation
    const EMPTY = `<div class="empty">Describe what the customer needs in plain English — OS, parallelism, how to split, browsers, tags, tunnel, reports, retries…<br>I'll update the YAML and check it against the knowledge base.</div>`;
    if (!msgs.length && !(busyLabel || "").startsWith("Thinking")) {
      log.innerHTML = EMPTY;
    } else {
      log.innerHTML = (talk.length ? "" : EMPTY) + msgs
        .map((m) => {
          if (m.role === "event") {
            const ic = { ok: "✓", warn: "!", bad: "✕" }[m.tone] || "•";
            const time = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const open = m.url ? ` <a data-url="${esc(m.url)}" title="${esc(m.url)}">Open ↗</a>` : "";
            return `<div class="event ${esc(m.tone)}${m.pane ? " go" : ""}" ${m.pane ? `data-pane="${esc(m.pane)}" title="Open the ${esc(m.pane)} tab"` : ""}><span class="ic">${ic}</span><span class="what"><b>${esc(m.text)}</b>${m.detail ? ` · ${esc(m.detail)}` : ""}${open}</span><span class="at">${time}</span></div>`;
          }
          if (m.role === "user") return `<div class="msg user">${esc(m.text)}</div>`;
          const meta = [m.backend ? `via ${esc(m.backend)}` : "", ...(m.sources || []).map((s) => `<a data-url="${esc(s.url)}" title="Open in Confluence">📄 ${esc(s.title.length > 60 ? s.title.slice(0, 57) + "…" : s.title)}</a>`)].filter(Boolean);
          return `<div class="msg assistant ${m.error ? "error" : ""}">${md(m.text)}${m.applied ? `<div class="applied ${m.applied.startsWith("⚠") ? "bad" : ""}">${m.change?.undone ? `<s>${esc(m.applied)}</s> <span class="muted">Undone</span>` : `${esc(m.applied)} <a class="view-yaml">View YAML →</a>${m.change ? ` · <a class="undo" data-id="${m.change.id}" title="Undo this change (and any made after it)">Undo</a>` : ""}`}</div>` : ""}${changeBlock(m)}${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}</div>`;
        })
        .join("") + ((busyLabel || "").startsWith("Thinking") ? `<div class="msg assistant"><span class="typing"><i></i><i></i><i></i></span></div>` : "");
      log.querySelectorAll("a[data-url]").forEach((a) => (a.onclick = () => send("openLink", { url: a.dataset.url })));
      log.querySelectorAll("a.view-yaml").forEach((a) => (a.onclick = () => showPane("yaml")));
      log.querySelectorAll(".event.go").forEach((el) => (el.onclick = (e) => { if (!e.target.closest("a")) showPane(el.dataset.pane); }));
      log.querySelectorAll("a.undo").forEach((a) => (a.onclick = () => send("undoChat", { id: +a.dataset.id })));
      log.querySelectorAll(".fix-errors").forEach((b) => (b.onclick = () => send("chat", { text: `Fix these validation errors:\n${b.dataset.errors}` })));
      log.querySelectorAll("details.diff").forEach((el) => (el.ontoggle = () => (el.open ? openDiffs.add(+el.dataset.id) : openDiffs.delete(+el.dataset.id))));
      log.scrollTop = log.scrollHeight;
    }
    $("#chips").innerHTML = talk.length > 2 ? "" : suggestions().map((s) => `<button class="chip">${esc(s)}</button>`).join("");
    $("#chips").querySelectorAll(".chip").forEach((c) => (c.onclick = () => send("chat", { text: c.textContent })));
    const thinking = (busyLabel || "").startsWith("Thinking");
    $("#sendBtn").textContent = thinking ? "Stop" : "Send";
  }

  function renderYaml() {
    if (document.activeElement !== ta || !S.dirty) {
      if (ta.value !== S.yaml) ta.value = S.yaml || "";
    }
    updateGutter();
    const r = S.result || {};
    $("#verBadge").textContent = r.yamlVersion ? `v${r.yamlVersion}` : "";
    $("#edited").textContent = S.dirty ? "● edited" : "";
    $("#genError").innerHTML = S.error ? `<div class="error-banner">${esc(S.error)}</div>` : "";
    $("#dry").disabled = r.yamlVersion === "0.2" && !S.dirty;
    $("#dry").title = r.yamlVersion === "0.2" ? "v0.2 discovery runs on HyperExecute" : "Run the discovery command locally";
  }

  function renderChecks() {
    document.querySelectorAll(".tab").forEach((t) => { t.classList.toggle("active", t.dataset.tab === activeTab); t.setAttribute("aria-selected", t.dataset.tab === activeTab); });
    const v = S?.validation;
    const notes = [...(S?.result?.notes || [])];
    $("#nVal").textContent = v ? (v.errors.length ? `(${v.errors.length}✕)` : v.warnings.length ? `(${v.warnings.length}!)` : "✓") : "";
    const yb = $("#yamlBadge");
    yb.textContent = v ? (v.errors.length ? `${v.errors.length}✕` : "✓") : "";
    yb.className = "n " + (v ? (v.errors.length ? "bad" : "good") : "");
    const el = $("#checks");
    const row = (cls, ic, text) => `<div class="check ${cls}"><span class="ic">${ic}</span><span>${esc(text)}</span></div>`;
    if (activeTab === "validation") {
      if (!v) return (el.innerHTML = `<div class="muted small">No YAML yet.</div>`);
      // problems first, then the generator's notes about this YAML
      el.innerHTML =
        (v.errors.length || v.warnings.length ? "" : row("ok", "✓", "Valid — no issues found.")) +
        v.errors.map((e) => row("err", "✕", e)).join("") +
        v.warnings.map((e) => row("warn", "!", e)).join("") +
        (v.info || []).map((e) => row("info", "i", e)).join("") +
        (notes.length ? `<div class="sub-h">About this YAML</div>${notes.map((n) => row("info", "i", n)).join("")}` : "");
    } else if (activeTab === "optimize") {
      renderOptimize(el);
    } else if (activeTab === "explain") {
      renderExplain(el);
    } else {
      const d = dryRun;
      if (!d) el.innerHTML = `<div class="muted small">Click “Dry-run” to run the discovery command locally and preview the tasks HyperExecute will create.</div>`;
      else if (d.matrix) el.innerHTML = row("info", "i", `Matrix mode: ${d.tasks} task(s) from keys ${d.matrixKeys.join(", ")}.`);
      else
        el.innerHTML =
          row(d.count ? "ok" : "err", d.count ? "✓" : "✕", `${d.count} test unit(s) discovered${d.exit ? ` (exit ${d.exit})` : ""}${d.count ? " — saved; the next run is checked against this count" : ""}`) +
          `<pre class="cmd">${esc(d.command)}</pre>` +
          (d.items.length ? `<ol class="disc-list">${d.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>` : "") +
          (d.sample.length ? `<div class="small muted">First task runs:</div>${d.sample.map((s) => `<pre class="cmd">${esc(s)}</pre>`).join("")}` : "") +
          (d.stderr ? `<div class="small muted">stderr:</div><pre class="cmd">${esc(d.stderr)}</pre>` : "");
    }
  }

  // every line of the YAML with what it does; click a line to select it in the editor
  function renderExplain(el) {
    const lines = (S?.explain || []).filter((l) => l.kind !== "blank" && l.kind !== "continued");
    if (!lines.length) return (el.innerHTML = `<div class="muted small">No YAML yet.</div>`);
    el.innerHTML =
      `<div class="explain-h"><span class="muted small">What each line does on HyperExecute. Click a line to find it in the YAML.</span><button class="btn small" id="annotated" title="Open the YAML with each explanation as a comment above its line">Open annotated copy</button></div>` +
      `<div class="explain">${lines.map((l) => `<div class="ex ${l.kind}" data-line="${l.n}"><span class="ln">${l.n}</span><code>${esc(l.text.trim())}</code><span class="what">${md(l.what)}</span></div>`).join("")}</div>`;
    $("#annotated").onclick = () => send("openAnnotated");
    el.querySelectorAll(".ex[data-line]").forEach((r) => (r.onclick = () => goToLine(+r.dataset.line)));
  }
  function goToLine(n) {
    const lines = ta.value.split("\n");
    const start = lines.slice(0, n - 1).reduce((a, l) => a + l.length + 1, 0);
    ta.focus();
    ta.setSelectionRange(start, start + (lines[n - 1] || "").length);
    ta.scrollTop = Math.max(0, (n - 4) * (parseFloat(getComputedStyle(ta).lineHeight) || 18));
  }

  let toastTimer;
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") { S = m.state; render(); }
    else if (m.type === "showPane") { showPane(m.pane); if (m.tab) { activeTab = m.tab; renderChecks(); } }
    else if (m.type === "busy") {
      busyLabel = m.label;
      $("#busy").classList.toggle("on", !!m.label);
      if (S) renderChat();
    } else if (m.type === "validation") { S.validation = m.validation; S.dirty = m.dirty; if (m.explain) S.explain = m.explain; renderChecks(); $("#edited").textContent = S.dirty ? "● edited" : ""; }
    else if (m.type === "dryRun") { dryRun = m.result; activeTab = "discovery"; renderChecks(); }
    else if (m.type === "toast") {
      const t = $("#toast");
      t.textContent = m.text;
      t.className = "show " + (m.kind === "error" ? "error" : "");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (t.className = ""), 3200);
    }
  });

  // ================= LambdaTest account =================
  $("#ltSave").onclick = () => {
    $("#ltState").textContent = "Checking…";
    $("#ltState").className = "small muted";
    send("ltAccountSave", { username: $("#ltUser").value, accessKey: $("#ltKey").value });
  };
  $("#ltTest").onclick = () => { $("#ltState").textContent = "Checking…"; send("ltAccountTest"); };
  $("#ltClear").onclick = () => { $("#ltUser").value = ""; $("#ltKey").value = ""; send("ltAccountClear"); };
  $("#ltEmbed").onchange = (e) => send("setEmbedCreds", { on: e.target.checked });
  function renderAccount() {
    const m = S.meta || {};
    if (document.activeElement !== $("#ltUser") && !$("#ltUser").value) $("#ltUser").value = m.ltUser || "";
    $("#ltKey").placeholder = m.ltReady ? "saved — type to replace" : "paste your access key";
    $("#ltEmbed").checked = m.embedCreds !== false;
    $("#ltEmbedNote").textContent = m.embedCreds === false
      ? "YAMLs use ${{ .secrets.LT_USERNAME }} references (safe to commit); ▶ Run fills them in."
      : m.ltReady ? "New YAMLs contain your account, so you don't edit them. Don't commit them to a shared repo or send them to a customer." : "Once saved, new YAMLs contain your account automatically.";
    if (!$("#ltState").dataset.set) {
      $("#ltState").textContent = m.ltReady ? "✓ saved" : "not set";
      $("#ltState").className = "small " + (m.ltReady ? "ok" : "warn");
    }
  }

  // ================= credentials & reporting scan =================
  $("#rescan").onclick = () => send("rescan");
  function renderScan() {
    const el = $("#scan");
    const sc = S.scan;
    const creds = sc?.credentials || [];
    const rep = sc?.reporting || [];
    const badge = $("#setupBadge");
    badge.textContent = creds.length ? `${creds.length}🔑` : "";
    badge.className = "n " + (creds.length ? "bad" : "");
    if (!sc) { el.innerHTML = `<span class="muted small">Open a repo to scan.</span>`; return; }
    const auto = creds.filter((c) => c.autoFix).length;
    const loc = (f) => `<a class="loc" data-file="${esc(f.file)}" data-line="${f.line}">${esc(f.file)}:${f.line}</a>`;
    el.innerHTML =
      `<div class="scan-h ${creds.length ? "bad" : "good"}">${creds.length ? `✕ ${creds.length} hard-coded LambdaTest credential${creds.length > 1 ? "s" : ""}` : "✓ No hard-coded LambdaTest credentials"}</div>` +
      (creds.length
        ? `<ul class="findings">${creds.map((c) => `<li>${loc(c)} <span class="tag soft">${esc(c.kind)}</span> <code>${esc(c.value || `${c.username}:${c.accessKey}`)}</code>${c.autoFix ? "" : ` <span class="warn small">edit by hand</span>`}</li>`).join("")}</ul>` +
          (auto ? `<button class="btn primary" id="fixCreds">Replace ${auto} with LT_USERNAME / LT_ACCESS_KEY</button>` : "") +
          `<div class="small muted" style="margin-top:6px">After replacing, runs use the account in the card above (▶ Run) or HyperExecute secrets.</div>`
        : "") +
      `<div class="scan-h ${rep.length ? "warn" : "good"}" style="margin-top:10px">${rep.length ? `! ${rep.length} place${rep.length > 1 ? "s" : ""} that report to the customer's side` : "✓ No customer-side reporting found"}</div>` +
      (rep.length ? `<ul class="findings">${rep.map((r) => `<li><b>${esc(r.name)}</b> — ${loc(r)}<div class="small muted">${esc(r.why)} <i>${esc(r.fix)}</i></div></li>`).join("")}</ul>` : "");
    el.querySelectorAll("a.loc").forEach((a) => (a.onclick = () => send("openFile", { file: a.dataset.file, line: +a.dataset.line })));
    const fx = $("#fixCreds");
    if (fx) fx.onclick = () => send("fixCredentials");
  }

  // ================= Grid (capabilities) =================
  const caps = { browser: "Chrome", version: "latest", platform: "Windows 11", resolution: "1920x1080", build: "", project: "", video: true, network: false, console: false, visual: false, tunnel: false, headless: false };
  let capsLists = null;
  let capsResult = null;
  let gridLoaded = false;
  const loadGrid = () => { if (!gridLoaded && S?.profile) { gridLoaded = true; send("capsOptions", { opts: caps }); send("capsGenerate", { opts: caps }); } };
  document.querySelector('.mtab[data-pane="grid"]').addEventListener("click", loadGrid);
  let capsTimer;
  const regenCaps = (refreshLists) => {
    clearTimeout(capsTimer);
    capsTimer = setTimeout(() => { if (refreshLists) send("capsOptions", { opts: caps }); send("capsGenerate", { opts: caps }); }, 250);
  };
  function renderCapsForm() {
    const L = capsLists || { browsers: [caps.browser], versions: [caps.version], platforms: [caps.platform], resolutions: [caps.resolution] };
    const sel = (id, label, list, val) => `<div class="field"><label for="${id}">${label}</label><select id="${id}">${list.map((v) => `<option ${v === val ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></div>`;
    const txt = (id, label, val, ph) => `<div class="field"><label for="${id}">${label}</label><input type="text" id="${id}" value="${esc(val)}" placeholder="${esc(ph)}"></div>`;
    const tog = (id, label) => `<label class="toggle tight"><input type="checkbox" id="c-${id}" ${caps[id] ? "checked" : ""}> ${label}</label>`;
    if (!L.resolutions.includes(caps.resolution)) caps.resolution = L.resolutions.includes("1920x1080") ? "1920x1080" : L.resolutions[0];
    $("#capsForm").innerHTML =
      sel("c-browser", "Browser", L.browsers, caps.browser) + sel("c-version", "Version", L.versions, caps.version) +
      sel("c-platform", "Operating system", L.platforms, caps.platform) + sel("c-resolution", "Resolution", L.resolutions, caps.resolution) +
      txt("c-build", "Build name", caps.build, "HyperExecute build") + txt("c-project", "Project", caps.project, "HyperExecute") +
      `<div class="toggles">${tog("video", "Video")}${tog("network", "Network logs")}${tog("console", "Console logs")}${tog("visual", "Screenshots")}${tog("tunnel", "Tunnel")}${tog("headless", "Headless")}</div>`;
    for (const k of ["browser", "version", "platform"]) $(`#c-${k}`).onchange = (e) => { caps[k] = e.target.value; regenCaps(true); };
    $("#c-resolution").onchange = (e) => { caps.resolution = e.target.value; regenCaps(false); };
    for (const k of ["build", "project"]) $(`#c-${k}`).oninput = (e) => { caps[k] = e.target.value; regenCaps(false); };
    for (const k of ["video", "network", "console", "visual", "tunnel", "headless"]) $(`#c-${k}`).onchange = (e) => { caps[k] = e.target.checked; regenCaps(false); };
    $("#capsLive").textContent = capsLists ? (capsLists.live ? "live from LambdaTest" : "offline defaults") : "";
  }
  function renderCaps() {
    const r = capsResult;
    if (!r) return;
    const points = r.points || [];
    const onLT = points.filter((p) => p.usesLambdaTest).length;
    $("#driverSetup").innerHTML = points.length
      ? `<div class="small muted">${points.length} place${points.length === 1 ? "" : "s"}, ${onLT ? `${onLT} already on LambdaTest` : "none on LambdaTest yet"}. Click one to open it.</div><ul class="findings">${points.slice(0, 12).map((d) => `<li><a class="loc" data-file="${esc(d.file)}" data-line="${d.line}">${esc(d.file)}:${d.line}</a> <span class="tag soft">${esc(d.kind)}</span>${d.usesLambdaTest ? ` <span class="ok small">LambdaTest</span>` : ` <span class="warn small">not LambdaTest</span>`}<div><code>${esc(d.current)}</code></div></li>`).join("")}</ul>`
      : `<span class="muted small">${["cypress", "testcafe"].includes(r.framework) ? "This framework runs its browsers on the HyperExecute VM; there is no grid connection to change." : "No browser or device connection found. Check your base class, hooks or config file for where the driver is created."}</span>`;
    $("#driverSetup").querySelectorAll("a.loc").forEach((a) => (a.onclick = () => send("openFile", { file: a.dataset.file, line: +a.dataset.line })));
    const withCode = points.filter((p) => p.code);
    const blocks = (withCode.length ? withCode : [{ change: "Use this where your tests create their driver.", code: r.snippet.replace(/\bDRIVER\b/g, "driver") }]).slice(0, 6);
    $("#capsChanges").innerHTML = blocks.map((p, i) => `<div class="change">${p.file ? `<a class="loc" data-file="${esc(p.file)}" data-line="${p.line}">${esc(p.file)}:${p.line}</a> ` : ""}<span class="small">${esc(p.change)}</span>
      <div class="card-h"><span class="spacer"></span><button class="icon-btn small" data-copy="${i}">Copy</button></div><pre class="code">${esc(p.code)}</pre>${p.imports ? `<div class="small muted">Imports, if missing: ${esc(p.imports.join(", "))}</div>` : ""}</div>`).join("");
    $("#capsChanges").querySelectorAll("a.loc").forEach((a) => (a.onclick = () => send("openFile", { file: a.dataset.file, line: +a.dataset.line })));
    $("#capsChanges").querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => send("copyText", { text: blocks[+b.dataset.copy].code })));
    $("#capsNotes").innerHTML = `<div>• Edit these lines in your own files. The Studio doesn't create or change connection files.</div>` + r.notes.filter((n) => !/connection points/.test(n)).map((n) => `<div>• ${esc(n)}</div>`).join("");
  }

  // ================= Optimize =================
  let optimizeResult = null;
  $("#optimize").onclick = () => { activeTab = "optimize"; optimizeResult = { loading: true }; renderChecks(); send("optimize"); };
  function renderOptimize(el) {
    const o = optimizeResult;
    if (!o) {
      el.innerHTML = `<div class="muted small">Checks this YAML for speed, cost and reliability improvements.</div><div class="row"><button class="btn small" id="optRun">Find improvements</button></div>`;
      $("#optRun").onclick = () => $("#optimize").click();
      return;
    }
    if (o.loading) return (el.innerHTML = `<div class="muted small">Analyzing…</div>`);
    if (o.error) return (el.innerHTML = `<div class="check err"><span class="ic">✕</span><span>${esc(o.error)}</span></div>`);
    if (!o.suggestions.length) return (el.innerHTML = `<div class="check ok"><span class="ic">✓</span><span>Nothing to optimize — this YAML already follows the recommendations.</span></div>`);
    el.innerHTML =
      (o.units ? `<div class="small muted">${o.units} test unit(s) to split.</div>` : "") +
      o.suggestions.map((s) => `<label class="opt"><input type="checkbox" value="${esc(s.id)}" ${s.severity !== "low" ? "checked" : ""}><span><span class="sev ${s.severity}">${s.severity}</span> <b>${md(s.title)}</b><div class="small muted">${md(s.why)}</div></span></label>`).join("") +
      `<div class="row" style="margin-top:6px"><button class="btn primary" id="applyOpt">Apply selected</button><button class="btn ghost" id="applyAll">Apply all</button></div>`;
    const ids = () => [...el.querySelectorAll(".opt input:checked")].map((i) => i.value);
    $("#applyOpt").onclick = () => ids().length && send("applyOptimizations", { ids: ids() });
    $("#applyAll").onclick = () => send("applyOptimizations", { ids: "all" });
  }

  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") { renderAccount(); renderScan(); if (!S.profile) gridLoaded = false; }
    else if (m.type === "ltStatus") { const st = $("#ltState"); st.dataset.set = "1"; st.textContent = (m.ok ? "✓ " : "✕ ") + m.text; st.className = "small " + (m.ok ? "ok" : "bad"); if (m.ok) $("#ltKey").value = ""; }
    else if (m.type === "capsOptions") { capsLists = m.result; caps.browser = m.result.browser; caps.platform = m.result.platform; if (!m.result.versions.includes(caps.version)) caps.version = "latest"; renderCapsForm(); }
    else if (m.type === "caps") { capsResult = m.result; renderCaps(); }
    else if (m.type === "optimize") { optimizeResult = m.result; activeTab = "optimize"; showPane("yaml"); renderChecks(); $("#nOpt").textContent = m.result.suggestions?.length ? `(${m.result.suggestions.length})` : ""; }
  });
  renderCapsForm();

  // ================= Runs (watch → diagnose → fix → rerun) =================
  const runLog = $("#runLog");
  let runTimer;
  const runOpts = () => ({ auto: $("#runAuto").checked, maxAttempts: +$("#runMax").value });
  $("#runStart").onclick = () => { runLog.textContent = ""; send("run", runOpts()); };
  $("#runStop").onclick = () => send("runStop");
  $("#runOpenLog").onclick = () => send("runOpenLog");
  $("#runAuto").onchange = $("#runMax").onchange = () => send("runSetAuto", runOpts());
  $("#run").onclick = () => { runLog.textContent = ""; send("run", runOpts()); };
  const STATUS = {
    running: ["run", "Running…"],
    passed: ["good", "✓ Passed"],
    "passed-with-failures": ["warn", "Finished — some tests failed"],
    fixable: ["warn", "Failed — fixable in the YAML"],
    "fixable-tests": ["warn", "Some tests failed for YAML reasons"],
    "needs-input": ["warn", "Tests need an environment value"],
    "test-failures": ["bad", "Tests failed — not a YAML problem"],
    "auth-error": ["bad", "LambdaTest login failed"],
    "needs-attention": ["warn", "Failed — needs your attention"],
    unknown: ["bad", "Failed — cause not recognized"],
    stopped: ["muted", "Stopped"],
  };
  const fmtDur = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
  function renderRun() {
    const r = S.run;
    const running = r?.status === "running";
    $("#runStart").disabled = running;
    $("#runStop").disabled = !running;
    const badge = $("#runsBadge");
    const [bcls] = r ? STATUS[r.status] || ["muted"] : [""];
    badge.textContent = !r ? "" : running ? "●" : bcls === "good" ? "✓" : bcls === "bad" ? "✕" : bcls === "warn" ? "!" : "";
    badge.className = "n " + (running ? "run" : bcls);
    if (!r) {
      $("#runStatus").innerHTML = `<div class="muted small">Runs the job with your account, streams the log here, and diagnoses failures. With <b>Auto-fix &amp; rerun</b>, YAML problems are fixed and the job rerun automatically; test failures are never "fixed" by rerunning.</div>`;
      $("#runDiag").innerHTML = "";
      return;
    }
    if (!runLog.textContent && r.tail) runLog.textContent = r.tail;
    const [cls, label] = STATUS[r.status] || ["muted", r.status];
    const elapsed = () => Math.round(((running ? Date.now() : r.startedAt + (r.history.at(-1)?.durationSec || 0) * 1000) - r.startedAt) / 1000);
    $("#runStatus").innerHTML = `<div class="run-line"><span class="status ${cls}">${esc(label)}</span><span class="small muted">Attempt ${r.attempt}/${r.maxAttempts}${r.auto ? " · auto-fix on" : ""} · <span id="runElapsed">${fmtDur(elapsed())}</span></span>${r.jobUrl ? `<a class="small" id="jobLink">Open job ↗</a>` : ""}</div>`;
    if (r.jobUrl) $("#jobLink").onclick = () => send("openLink", { url: r.jobUrl });
    clearInterval(runTimer);
    if (running) runTimer = setInterval(() => { const el = $("#runElapsed"); if (el) el.textContent = fmtDur(elapsed()); }, 1000);
    $("#runAuto").checked = !!r.auto;
    $("#runMax").value = String(r.maxAttempts);

    const d = r.diagnosis;
    let html = "";
    if (d && !running && d.tests?.failed) {
      const t = d.tests;
      const pill = { code: "bad", yaml: "warn", unknown: "muted" };
      const causeLabel = { code: "Code", yaml: "YAML", unknown: "?" };
      html += `<div class="small"><b>${t.failed} failed</b> of ${t.total}: ${t.code} code (left alone) · ${t.yaml} YAML/environment${t.unknown ? ` · ${t.unknown} unrecognized` : ""}</div>`;
      html += `<ul class="findings tests">${t.list.map((x) => `<li><span class="status ${pill[x.cause]}">${causeLabel[x.cause]}</span> <b>${esc(x.label)}</b><div class="small muted">${esc(x.reason)}</div>${x.fix ? `<div class="small ok">→ ${esc(x.fix)}</div>` : ""}${x.needsValue ? `<div class="field"><label for="val-${esc(x.needsValue)}">Value for ${esc(x.needsValue)}</label><input type="text" class="needs-value" id="val-${esc(x.needsValue)}" data-name="${esc(x.needsValue)}" placeholder="e.g. https://…"></div>` : ""}${x.note ? `<div class="small">${esc(x.note)}</div>` : ""}${x.evidence ? `<details><summary class="small muted">Error</summary><pre class="cmd">${esc(x.evidence)}</pre></details>` : ""}</li>`).join("")}</ul>`;
    }
    const dc = r.discoveryCheck;
    if (dc && !running && dc.verdict !== "n/a") {
      const good = dc.verdict === "ok";
      const nums = [dc.expectedItems != null ? `expected ${dc.expectedItems} (${esc(dc.expectedItemsFrom)})` : "", dc.platformDiscovered != null ? `HyperExecute discovered ${dc.platformDiscovered}` : "", dc.executedTests != null ? `${dc.executedTests} test case(s) in reports` : ""].filter(Boolean).join(" · ");
      html += `<div class="disc-check ${good ? "good" : dc.verdict === "unconfirmed" ? "muted" : "bad"}"><b>${good ? "✓ Test count looks right" : dc.verdict === "zero-tests" ? "✕ 0 tests ran" : dc.verdict === "unconfirmed" ? "Test count not confirmed" : "! Test count differs"}</b>${nums ? `<div class="small">${nums}</div>` : ""}${dc.message ? `<div class="small muted">${esc(dc.message)}</div>` : ""}</div>`;
    }
    if (r.learned && !running) html += `<div class="disc-check good"><b>✓ Fix remembered</b><div class="small">The change made before this run fixed it. When this failure comes back, it's suggested first (also saved in <code>.hyperexecute/team.json</code> for the team).</div></div>`;
    if (r.fixedBefore && !running) {
      const f = r.fixedBefore;
      const diff = [...(f.change?.removed || []).map((l) => `- ${l}`), ...(f.change?.added || []).map((l) => `+ ${l}`)].join("\n");
      html += `<div class="disc-check"><b>Fixed before${f.worked > 1 ? ` (${f.worked}×)` : ""}</b><div class="small">This failure was fixed ${f.from === "team" ? "by the team" : "on this machine"} with this YAML change, and the next run passed. Ask AI to fix uses it first.</div>${diff ? `<pre class="cmd">${esc(diff)}</pre>` : ""}</div>`;
    }
    if (r.savedForReview && !running) html += `<div class="small muted">The unrecognized part of this failure was saved (masked, on this machine) for rule review — <code>npm run feedback</code>.</div>`;
    if (d && !running) {
      html += d.diagnoses.length
        ? `<ul class="findings">${d.diagnoses.map((x) => `<li><b>${esc(x.title)}</b><div class="small muted">${esc(x.why)}</div>${x.fixSummary ? `<div class="small ok">→ Fix: ${esc(x.fixSummary)}</div>` : ""}${x.advice ? `<div class="small">${esc(x.advice)}</div>` : ""}${x.evidence ? `<details><summary class="small muted">Evidence</summary><pre class="cmd">${esc(x.evidence)}</pre></details>` : ""}</li>`).join("")}</ul>`
        : r.status !== "passed" ? `<div class="small muted">No known failure pattern matched${r.logFiles?.length ? ` in the output and ${r.logFiles.length} downloaded log file(s)` : ""}.</div>` : "";
      const btns = [];
      if (["fixable-tests", "needs-input"].includes(r.status)) {
        const n = (d.tests?.list || []).filter((x) => x.cause === "yaml" && x.fixKey).length;
        btns.push(`<button class="btn primary" id="runFixTests">Fix YAML &amp; rerun ${n} affected test${n === 1 ? "" : "s"}</button>`);
      }
      if ((d.tests?.failed || 0) > 0) btns.push(`<button class="btn ghost" id="runFailedOnly" title="Rerun the failed tests without changing the YAML">Rerun failed as-is</button>`);
      if (r.status === "fixable") btns.push(`<button class="btn primary" id="runFix">Apply fixes &amp; rerun</button>`, `<button class="btn ghost" id="runFixOnly">Apply only</button>`);
      if (["unknown", "needs-attention", "fixable"].includes(r.status)) btns.push(`<button class="btn ${r.status === "fixable" ? "ghost" : "primary"}" id="runAskAI">Ask AI to fix</button>`);
      if (r.status !== "running") btns.push(`<button class="btn ghost" id="runAgain">Rerun</button>`);
      html += `<div class="row">${btns.join("")}</div>`;
    }
    if (r.aiSuggestion) {
      const s = r.aiSuggestion;
      html += `<div class="ai-sugg"><div class="small muted">AI${s.backend ? ` (${esc(s.backend)})` : ""}:</div><div class="small">${md(s.reply)}</div>${
        s.yaml ? (s.valid ? `<details><summary class="small muted">Proposed YAML</summary><pre class="cmd">${esc(s.yaml)}</pre></details><div class="row"><button class="btn primary" id="aiApply">Apply AI fix &amp; rerun</button></div>` : `<div class="small bad">Its YAML doesn't validate: ${esc((s.errors || []).join("; "))}</div>`) :
        s.options ? `<div class="row"><button class="btn primary" id="aiApply">Apply AI fix &amp; rerun</button></div>` : ""
      }</div>`;
    }
    if (r.note) html += `<div class="small warn">${esc(r.note)}</div>`;
    if (r.history?.length) html += `<div class="hist"><div class="small muted">Attempts</div>${r.history.map((h) => `<div class="small">#${h.attempt}${h.targeted ? " (affected tests)" : ""} <span class="${(STATUS[h.status] || ["muted"])[0]}">${esc((STATUS[h.status] || ["", h.status])[1])}</span> · ${fmtDur(h.durationSec)}${h.changes.length ? ` → ${esc(h.changes.join("; "))}` : ""}</div>`).join("")}</div>`;
    $("#runDiag").innerHTML = html;
    const on = (id, fn) => { const el = $("#" + id); if (el) el.onclick = fn; };
    on("runFix", () => { runLog.textContent = ""; send("runApplyFixes", { rerun: true }); });
    on("runFixTests", () => {
      const values = {};
      document.querySelectorAll(".needs-value").forEach((i) => { if (i.value.trim()) values[i.dataset.name] = i.value.trim(); });
      runLog.textContent = "";
      send("runApplyFixes", { rerun: true, values });
    });
    on("runFailedOnly", () => { runLog.textContent = ""; send("runRerun", { onlyFailed: true }); });
    on("runFixOnly", () => send("runApplyFixes", { rerun: false }));
    on("runAskAI", () => send("runAskAI"));
    on("runAgain", () => { runLog.textContent = ""; send("runRerun"); });
    on("aiApply", () => { runLog.textContent = ""; send("runApplyAI", { rerun: true }); });
  }
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") renderRun();
    else if (m.type === "runLog") {
      const atBottom = runLog.scrollTop + runLog.clientHeight >= runLog.scrollHeight - 30;
      runLog.textContent = (runLog.textContent + m.chunk).slice(-200000);
      if (atBottom) runLog.scrollTop = runLog.scrollHeight;
    } else if (m.type === "runMeta" && S?.run) { S.run.jobUrl = m.jobUrl; renderRun(); }
  });

  // ================= update banner =================
  window.addEventListener("message", (e) => {
    if (e.data.type !== "updateReady" || $("#updateBanner")) return;
    const b = document.createElement("div");
    b.id = "updateBanner";
    b.className = "update-banner";
    b.innerHTML = `<span>Version ${esc(e.data.version)} is installed (running ${esc(e.data.running)}).</span><button class="btn primary">Reload to update</button>`;
    b.querySelector("button").onclick = () => send("reloadWindow");
    $(".top").prepend(b);
  });

  send("ready");
})();
