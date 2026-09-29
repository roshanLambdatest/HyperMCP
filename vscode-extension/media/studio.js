// HyperExecute YAML Studio — webview UI (vanilla JS).
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
        <button class="icon-btn" id="browse" title="Choose another folder">📁</button>
        <button class="icon-btn" id="reanalyze" title="Re-analyze repo">↻</button>
      </div>
      <div class="pills">
        <button class="pill" id="backendPill" title="Choose AI backend"><span class="dot"></span><span></span></button>
        <button class="pill" id="kbPill" title="Connect Confluence knowledge base"><span class="dot"></span><span></span></button>
      </div>
    </header>
    <nav class="main-tabs" role="tablist">
      <button class="mtab" data-pane="chat">Chat</button>
      <button class="mtab" data-pane="yaml">YAML <span class="n" id="yamlBadge"></span></button>
      <button class="mtab" data-pane="setup">Setup</button>
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
      <div class="yaml-h"><span id="yamlTitle">hyperexecute.yaml</span><span class="badge-v" id="verBadge"></span><span class="edited" id="edited"></span><span class="spacer"></span><span class="muted small" id="lines"></span></div>
      <div id="genError"></div>
      <div class="editor"><div class="gutter" id="gutter">1</div><textarea id="yaml" spellcheck="false" aria-label="Generated YAML"></textarea></div>
      <div class="actions">
        <button class="btn primary" id="save">Save to repo</button>
        <button class="btn" id="openEd" title="Save and open in an editor tab">Open</button>
        <button class="btn" id="dry">Dry-run</button>
        <button class="btn" id="copy">Copy</button>
        <button class="btn ghost" id="run" title="Save, then run the HyperExecute CLI in a terminal">▶ Run</button>
      </div>
      <div class="checks">
        <div class="tabs" role="tablist">
          <button class="tab" data-tab="validation">Validation<span class="n" id="nVal"></span></button>
          <button class="tab" data-tab="notes">Notes<span class="n" id="nNotes"></span></button>
          <button class="tab" data-tab="discovery">Discovery</button>
        </div>
        <div class="panel" id="checks"></div>
      </div>
    </section>
    <section class="pane scroll" data-pane="setup">
      <div class="card"><div class="card-h">Detected stack<span class="spacer"></span><span id="fileState" class="muted small"></span></div><div class="card-b" id="stack"></div></div>
      <div class="card"><div class="card-h">Options<span class="spacer"></span><button class="icon-btn small" id="resetOpts" title="Reset to detected defaults">Reset</button></div><div class="card-b"><div class="form" id="opts"></div></div></div>
      <div class="card"><div class="card-h">Conversation</div><div class="card-b"><button class="btn ghost" id="clearChat">Clear chat</button></div></div>
    </section>
    <div id="busy"></div><div id="toast" role="status"></div>`;

  let pane = "chat";
  const showPane = (p) => {
    pane = p;
    document.querySelectorAll(".pane").forEach((el) => el.classList.toggle("active", el.dataset.pane === p));
    document.querySelectorAll(".mtab").forEach((el) => el.classList.toggle("active", el.dataset.pane === p));
    if (p === "yaml") updateGutter();
  };
  document.querySelectorAll(".mtab").forEach((t) => (t.onclick = () => showPane(t.dataset.pane)));
  $("#stackline").onclick = () => showPane("setup");

  // ---------- events ----------
  $("#repoSel").onchange = (e) => send("selectRepo", { path: e.target.value });
  $("#browse").onclick = () => send("browseRepo");
  $("#reanalyze").onclick = () => send("reanalyze");
  $("#backendPill").onclick = () => send("command", { id: "hyperexecute.chooseBackend" });
  $("#kbPill").onclick = () => send("command", { id: "hyperexecute.setAtlassianToken" });
  $("#resetOpts").onclick = () => send("resetOptions");
  $("#clearChat").onclick = () => send("clearChat");
  $("#save").onclick = () => send("save");
  $("#openEd").onclick = () => send("openInEditor");
  $("#copy").onclick = () => send("copy");
  $("#run").onclick = () => send("run");
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
  ta.addEventListener("scroll", () => ($("#gutter").scrollTop = ta.scrollTop));
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Tab") { e.preventDefault(); document.execCommand("insertText", false, "  "); }
  });
  function updateGutter() {
    const n = ta.value.split("\n").length;
    $("#gutter").textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
    $("#lines").textContent = `${n} lines`;
  }

  // ---------- rendering ----------
  function render() {
    if (!S) return;
    renderTop();
    renderStack();
    renderOptions();
    renderChat();
    renderYaml();
    renderChecks();
  }

  function renderTop() {
    const sel = $("#repoSel");
    sel.innerHTML = S.repos.length ? S.repos.map((r) => `<option value="${esc(r.path)}" ${r.path === S.repo ? "selected" : ""}>${esc(r.name)}</option>`).join("") : `<option>Open a folder or click 📁</option>`;
    const m = S.meta || {};
    const bp = $("#backendPill");
    bp.children[0].className = "dot " + (m.backendId === "rules" ? "off" : "on");
    bp.children[1].textContent = `AI: ${m.backend || "…"}`;
    const kp = $("#kbPill");
    kp.children[0].className = "dot " + (m.confluence ? "on" : "off");
    kp.children[1].textContent = m.confluence ? `Confluence: ${m.confluenceSpace}` : "Connect Confluence";
  }

  function renderStackLine() {
    const p = S.profile, r = S.result || {};
    const el = $("#stackline");
    if (!p) { el.innerHTML = `<span class="muted">Open a folder with test code to begin</span>`; return; }
    const t = p.tests;
    const count = t.scenarioCount ? `${t.scenarioCount} scenarios` : t.methodCount ? `${t.methodCount} tests` : t.fileCount ? `${t.fileCount} spec files` : t.classCount ? `${t.classCount} classes` : "no tests found";
    el.innerHTML = `<span class="tag">${esc(r.framework || p.language || "?")}</span><span>${esc([p.language, p.buildTool || p.packageManager].filter(Boolean).join(" · "))} · ${count}${r.yamlVersion ? " · YAML v" + r.yamlVersion : ""}</span>${p.warnings?.length ? `<span class="warn-n">⚠ ${p.warnings.length}</span>` : ""}<span class="chev">›</span>`;
  }

  function renderStack() {
    renderStackLine();
    const el = $("#stack");
    const p = S.profile;
    if (!p) { el.innerHTML = `<div class="muted small">Open a workspace folder with test automation code, or pick one with 📁.</div>`; return; }
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
      ${w.length ? `<details class="warn"><summary>⚠ ${w.length} thing${w.length > 1 ? "s" : ""} to check</summary><ul>${w.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}`;
    $("#fileState").textContent = S.existingFile ? `${S.existingFile} exists in repo` : "";
  }

  function renderOptions() {
    const el = $("#opts");
    const o = S.options || {};
    const r = S.result || {};
    const splits = r.supportedSplits || ["class"];
    const sel = (id, label, opts, val) =>
      `<div class="field"><label for="${id}">${label}</label><select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></div>`;
    const num = (id, label, val, min, max) => `<div class="field"><label for="${id}">${label}</label><input type="number" id="${id}" value="${esc(val)}" min="${min}" max="${max}"></div>`;
    const retries = o.retryOnFailure === false ? 0 : o.maxRetries ?? 1;
    el.innerHTML =
      sel("o-ver", "YAML version", [["auto", `Auto (${r.yamlVersion ? "v" + r.yamlVersion : "…"})`], ["0.2", "v0.2 · native runner"], ["0.1", "v0.1 · raw discovery"]], o.yamlVersion || "auto") +
      sel("o-os", "Target OS", [["linux", "Linux"], ["win", "Windows"], ["win11", "Windows 11"], ["mac", "macOS"], ["mac13", "macOS 13"]], o.runson || "linux") +
      sel("o-mode", "Mode", [["autosplit", "Autosplit"], ["matrix", "Matrix"]], o.executionMode || r.executionMode || "autosplit") +
      sel("o-split", "Split by", splits.map((s) => [s, s[0].toUpperCase() + s.slice(1)]), o.splitBy || r.splitBy || splits[0]) +
      num("o-conc", "Concurrency (VMs)", o.concurrency ?? 5, 1, 500) +
      num("o-retry", "Retries", retries, 0, 5) +
      num("o-timeout", "Timeout (min)", o.globalTimeout ?? 90, 1, 150) +
      `<label class="toggle"><input type="checkbox" id="o-tunnel" ${o.tunnel ? "checked" : ""}> Tunnel</label>`;
    const push = (options) => send("setOptions", { options });
    $("#o-ver").onchange = (e) => push({ yamlVersion: e.target.value === "auto" ? null : e.target.value });
    $("#o-os").onchange = (e) => push({ runson: e.target.value });
    $("#o-mode").onchange = (e) => push({ executionMode: e.target.value, yamlVersion: e.target.value === "matrix" ? "0.1" : o.yamlVersion });
    $("#o-split").onchange = (e) => push({ splitBy: e.target.value });
    $("#o-tunnel").onchange = (e) => push({ tunnel: e.target.checked || null });
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
    s.push("Fail fast after 3 failures");
    s.push("Explain this YAML");
    return s.slice(0, 6);
  }

  function renderChat() {
    const log = $("#log");
    const msgs = S.chat || [];
    if (!msgs.length && !(busyLabel || "").startsWith("Thinking")) {
      log.innerHTML = `<div class="empty">Describe what the customer needs in plain English — OS, parallelism, how to split, browsers, tags, tunnel, reports, retries…<br>I'll update the YAML and check it against the knowledge base.</div>`;
    } else {
      log.innerHTML = msgs
        .map((m) => {
          if (m.role === "user") return `<div class="msg user">${esc(m.text)}</div>`;
          const meta = [m.backend ? `via ${esc(m.backend)}` : "", ...(m.sources || []).map((s) => `<a data-url="${esc(s.url)}" title="Open in Confluence">📄 ${esc(s.title.length > 60 ? s.title.slice(0, 57) + "…" : s.title)}</a>`)].filter(Boolean);
          return `<div class="msg assistant ${m.error ? "error" : ""}">${md(m.text)}${m.applied ? `<div class="applied ${m.applied.startsWith("⚠") ? "bad" : ""}">${esc(m.applied)} <a class="view-yaml">View YAML →</a></div>` : ""}${meta.length ? `<div class="meta">${meta.join("")}</div>` : ""}</div>`;
        })
        .join("") + ((busyLabel || "").startsWith("Thinking") ? `<div class="msg assistant"><span class="typing"><i></i><i></i><i></i></span></div>` : "");
      log.querySelectorAll("a[data-url]").forEach((a) => (a.onclick = () => send("openLink", { url: a.dataset.url })));
      log.querySelectorAll("a.view-yaml").forEach((a) => (a.onclick = () => showPane("yaml")));
      log.scrollTop = log.scrollHeight;
    }
    $("#chips").innerHTML = msgs.length > 2 ? "" : suggestions().map((s) => `<button class="chip">${esc(s)}</button>`).join("");
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
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === activeTab));
    const v = S?.validation;
    const notes = [...(S?.result?.notes || [])];
    $("#nVal").textContent = v ? (v.errors.length ? `(${v.errors.length}✕)` : v.warnings.length ? `(${v.warnings.length}!)` : "✓") : "";
    const yb = $("#yamlBadge");
    yb.textContent = v ? (v.errors.length ? `${v.errors.length}✕` : "✓") : "";
    yb.className = "n " + (v ? (v.errors.length ? "bad" : "good") : "");
    $("#nNotes").textContent = notes.length ? `(${notes.length})` : "";
    const el = $("#checks");
    const row = (cls, ic, text) => `<div class="check ${cls}"><span class="ic">${ic}</span><span>${esc(text)}</span></div>`;
    if (activeTab === "validation") {
      if (!v) return (el.innerHTML = `<div class="muted small">No YAML yet.</div>`);
      el.innerHTML =
        (v.errors.length || v.warnings.length ? "" : row("ok", "✓", "Valid — no issues found.")) +
        v.errors.map((e) => row("err", "✕", e)).join("") +
        v.warnings.map((e) => row("warn", "!", e)).join("") +
        (v.info || []).map((e) => row("info", "i", e)).join("");
    } else if (activeTab === "notes") {
      el.innerHTML = notes.length ? notes.map((n) => row("info", "i", n)).join("") : `<div class="muted small">No notes.</div>`;
    } else {
      const d = dryRun;
      if (!d) el.innerHTML = `<div class="muted small">Click “Dry-run discovery” to run the discovery command locally and preview the tasks HyperExecute will create.</div>`;
      else if (d.matrix) el.innerHTML = row("info", "i", `Matrix mode: ${d.tasks} task(s) from keys ${d.matrixKeys.join(", ")}.`);
      else
        el.innerHTML =
          row(d.count ? "ok" : "err", d.count ? "✓" : "✕", `${d.count} test unit(s) discovered${d.exit ? ` (exit ${d.exit})` : ""}`) +
          `<pre class="cmd">${esc(d.command)}</pre>` +
          (d.items.length ? `<ol class="disc-list">${d.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>` : "") +
          (d.sample.length ? `<div class="small muted">First task runs:</div>${d.sample.map((s) => `<pre class="cmd">${esc(s)}</pre>`).join("")}` : "") +
          (d.stderr ? `<div class="small muted">stderr:</div><pre class="cmd">${esc(d.stderr)}</pre>` : "");
    }
  }

  let toastTimer;
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (m.type === "state") { S = m.state; render(); }
    else if (m.type === "showPane") showPane(m.pane);
    else if (m.type === "busy") {
      busyLabel = m.label;
      $("#busy").classList.toggle("on", !!m.label);
      if (S) renderChat();
    } else if (m.type === "validation") { S.validation = m.validation; S.dirty = m.dirty; renderChecks(); $("#edited").textContent = S.dirty ? "● edited" : ""; }
    else if (m.type === "dryRun") { dryRun = m.result; activeTab = "discovery"; renderChecks(); }
    else if (m.type === "toast") {
      const t = $("#toast");
      t.textContent = m.text;
      t.className = "show " + (m.kind === "error" ? "error" : "");
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (t.className = ""), 3200);
    }
  });

  send("ready");
})();
