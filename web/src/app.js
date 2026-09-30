// HyperExecute Studio — browser version. Everything runs in this tab: the repo is read into an in-memory
// filesystem and the shared core (analyzer, generator, validator, optimizer, scanner, doctor) works on it.
// Network: api.lambdatest.com (live browser lists, optional account check) and, only if the visitor turns
// Claude on with their own key, api.anthropic.com. Source files are never sent anywhere.

import * as core from "./core-entry.js";
import { unzip, zipSync, strToU8 } from "fflate";
import { icon } from "./icons.js";
import { highlightYaml } from "./highlight.js";
import { respond, welcome, help } from "../../src/assistant.js";
import { SAMPLES } from "./samples.gen.js";
import "./kb.gen.js"; // customer-safe knowledge base, embedded at build time
import { searchKnowledge } from "../../src/knowledge.js";

const REPORT_URL = "https://github.com/roshanLambdatest/HyperMCP/issues/new";

const VERSION = __STUDIO_VERSION__;
const MAX_FILES = 20000;
const MAX_TEXT = 512 * 1024; // the analyzer doesn't read bigger files either
const IGNORED = new Set(["node_modules", ".git", "target", "build", "dist", "out", "bin", "obj", ".gradle", ".idea", ".vscode", "venv", ".venv", "env", "__pycache__", ".pytest_cache", "allure-results", "allure-report", "test-output", "playwright-report", "test-results", "coverage", ".next", ".cache"]);
const BINARY = /\.(png|jpe?g|gif|webp|ico|bmp|pdf|zip|gz|tgz|jar|war|ear|class|exe|dll|so|dylib|bin|woff2?|ttf|otf|eot|mp[34]|mov|avi|webm|wav|ogg|psd|apk|ipa|aab|db|sqlite)$/i;
const OS_NAME = { linux: "Linux", mac: "macOS", mac13: "macOS 13", win: "Windows", win11: "Windows 11" };

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
// the small markdown the assistant writes: paragraphs, "- " lists, "1. " lists, **bold**, `code`
function md(text) {
  const out = [];
  let list = null;
  const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
  let code = null;
  for (const raw of String(text).split("\n")) {
    const l = raw.trimEnd();
    if (/^\s*```/.test(l)) {
      if (code) { out.push(`<pre class="block scroll">${esc(code.join("\n"))}</pre>`); code = null; }
      else { close(); code = []; }
      continue;
    }
    if (code) { code.push(raw); continue; }
    const b = l.match(/^\s*[-•]\s+(.*)$/);
    const n = l.match(/^\s*\d+\.\s+(.*)$/);
    if (b || n) {
      const want = b ? "ul" : "ol";
      if (list !== want) { close(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((b || n)[1])}</li>`);
    } else if (!l.trim()) close();
    else { close(); out.push(`<p>${inline(l)}</p>`); }
  }
  close();
  if (code) out.push(`<pre class="block scroll">${esc(code.join("\n"))}</pre>`);
  return out.join("");
}
// wording in the shared core is written for LambdaTest engineers working on a customer's repo; here the visitor IS that customer
const visitor = (s) => String(s ?? "")
  .replace(/the customer's/gi, "your")
  .replace(/customer-side/gi, "external")
  .replace(/ Pass it as mavenProfile\.$/, " Pick it under Options, or tell me.")
  .replace(/ Pass extraMatrix \{[^}]*\} to spread them over VMs\.$/, " Say \"one project per VM\" to spread them out.");
import { plural, fwName, stackLine } from "../../src/names.js";
let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
function download(name, data, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function copy(text, what = "Copied") {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast("Couldn't copy — select the text and copy it manually"); }
}
const visitorOs = () => (/Win/i.test(navigator.platform) ? "win" : /Mac/i.test(navigator.platform) ? "mac" : "linux");

// ---------- state ----------
let ROOT = "/repo";
const S = {
  repoName: null, loaded: 0, profile: null, summary: null, scan: null,
  options: {}, result: null, yaml: "", generated: "", dirty: false, error: null, validation: null, parsed: null,
  history: [], chat: [], busy: false,
  tab: "checks", view: "chat",
  lt: { user: "", key: "", embed: true, state: null },
  ai: { key: "", on: false, state: null },
  opt: null, diag: null, logs: "", runOs: visitorOs(),
  caps: { browser: "Chrome", version: "latest", platform: "Windows 11", resolution: "1920x1080", build: "", project: "", video: true, network: false, console: false, visual: false, tunnel: false, headless: false },
  capsLists: null, capsResult: null,
};

// ---------- shell ----------
document.getElementById("app").innerHTML = `
  <header class="top">
    <button class="brand" id="home" title="Start over"><span class="mark">${icon.bolt}</span><span>HyperExecute Studio</span></button>
    <nav class="views hidden" id="views" aria-label="Show">
      <button data-v="chat">Chat</button><button data-v="yaml">YAML</button><button data-v="checks">Checks</button>
    </nav>
    <span class="spacer"></span>
    <span class="privacy" id="privacy">${icon.lock}Runs in your browser — code never uploaded</span>
    <button class="btn quiet sm hidden" id="newRepo">${icon.folder}<span>New repo</span></button>
    <button class="btn quiet icon" id="reportBtn" title="Report a problem" aria-label="Report a problem">${icon.alert}</button>
    <button class="btn quiet icon" id="settingsBtn" title="Settings: LambdaTest account and Claude" aria-label="Settings">${icon.gear}</button>
  </header>
  <main id="view"></main>
  <div id="toast" role="status" aria-live="polite"></div>
  <div class="dropzone hidden" id="dropzone"><div>${icon.folder}Drop to analyze</div></div>
  <dialog id="settings" aria-label="Settings"></dialog>
  <input type="file" id="pickFolder" webkitdirectory directory multiple class="hidden">
  <input type="file" id="pickZip" accept=".zip,application/zip" class="hidden">`;

$("#home").onclick = () => landing();
$("#newRepo").onclick = () => landing();
$("#settingsBtn").onclick = () => openSettings();
$("#reportBtn").onclick = () => reportProblem();
$("#pickFolder").onchange = (e) => fromFileList(e.target.files).finally(() => (e.target.value = ""));
$("#pickZip").onchange = (e) => e.target.files[0] && fromZip(e.target.files[0]).catch(fail).finally(() => (e.target.value = ""));
$$("#views button").forEach((b) => (b.onclick = () => setView(b.dataset.v)));
// drop a folder or zip anywhere on the page
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { dragDepth++; $("#dropzone").classList.remove("hidden"); } });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropzone").classList.add("hidden"); } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; $("#dropzone").classList.add("hidden"); fromDrop(e.dataTransfer).catch(fail); });

// ---------- landing ----------
const DEMO_YAML = `version: 0.1
runson: win11
autosplit: true
concurrency: 10
tunnel: true
env:
  LT_USERNAME: \${{ .secrets.LT_USERNAME }}
  LT_ACCESS_KEY: \${{ .secrets.LT_ACCESS_KEY }}
pre:
  - mvn -Dmaven.test.skip=true install
testDiscovery:
  type: raw
  mode: remote
  command: grep -rlE '@Test' src/test/java
testRunnerCommand: mvn test -Dtest="$test"
retryOnFailure: true
maxRetries: 1`;

function landing() {
  $("#newRepo").classList.add("hidden");
  $("#views").classList.add("hidden");
  $("#privacy").classList.remove("hidden");
  $("#view").innerHTML = `
    <div class="landing">
      <section class="hero">
        <div>
          <div class="eyebrow">For LambdaTest HyperExecute</div>
          <h1>Your test repo, running on HyperExecute <mark>in minutes</mark>.</h1>
          <p class="lead">Drop in your repo. Studio reads it, writes a HyperExecute YAML that's checked against the platform's rules, and talks you through the rest — right here in your browser.</p>
          <div class="cta">
            <button class="btn primary lg" id="chooseFolder">${icon.folder}Choose repo folder</button>
            <button class="btn lg" id="chooseZip">${icon.zip}Upload .zip</button>
          </div>
          <div class="gh"><input type="text" id="ghUrl" placeholder="…or paste a public GitHub repo URL" aria-label="GitHub repo URL" spellcheck="false"><button class="btn" id="ghGo">${icon.download}Import</button></div>
          ${S.pendingSetup ? `<div class="shared">${icon.info}<span>A setup was shared with you${S.pendingSetup.name ? ` for <b>${esc(S.pendingSetup.name)}</b>` : ""}. Load that repo and it's applied.</span></div>` : ""}
          <div class="try">No repo handy? Try a sample: ${Object.keys(SAMPLES).map((k) => `<button class="link" data-sample="${esc(k)}">${esc(SAMPLES[k].label)}</button>`).join(" · ")}</div>
          <ul class="trust">
            <li>${icon.lock}Your code is read in this tab and never uploaded</li>
            <li>${icon.check}Checked against HyperExecute's v0.1 and v0.2 rules</li>
            <li>${icon.pulse}Paste a failed job's log to get the cause and the fix</li>
          </ul>
          <div class="progress" id="progress" aria-live="polite"></div>
        </div>
        <div class="shot" aria-hidden="true">
          <div class="shot-bar"><i></i><i></i><i></i><span>hyperexecute.yaml</span><b>Valid</b></div>
          <div class="shot-body">
            <div class="shot-chat">
              <div class="bub bot">I read <b>checkout-tests</b>: Java 17 · Maven · TestNG, 14 test classes.</div>
              <div class="bub me">Windows 11, 10 VMs, and our staging site is internal</div>
              <div class="bub bot">Done: Windows 11 · 10 VMs in parallel · tunnel on. <span class="ok">The YAML is valid.</span></div>
            </div>
            <pre class="shot-yaml">${highlightYaml(DEMO_YAML)}</pre>
          </div>
        </div>
      </section>
      <section class="how">
        <div><span class="n">01</span><h3>Drop your repo</h3><p>Studio recognizes 20 frameworks across Java, Node, Python and .NET, and finds your tests, tags and settings.</p></div>
        <div><span class="n">02</span><h3>Say what you need</h3><p>"Windows 11, 10 VMs, split by scenario." The YAML updates and re-checks as you talk.</p></div>
        <div><span class="n">03</span><h3>Download and run</h3><p>Get the CLI command for your OS. If a run fails, paste the log and Studio finds the fix.</p></div>
      </section>
    </div>
    <p class="foot">HyperExecute Studio v${esc(VERSION)} · no sign-up needed</p>`;
  $("#chooseFolder").onclick = () => $("#pickFolder").click();
  $("#chooseZip").onclick = () => $("#pickZip").click();
  $$("[data-sample]").forEach((b) => (b.onclick = () => loadSample(b.dataset.sample).catch(fail)));
  const gh = () => { const v = $("#ghUrl").value; if (v.trim()) fromGithub(v).catch(fail); };
  $("#ghGo").onclick = gh;
  $("#ghUrl").onkeydown = (e) => { if (e.key === "Enter") gh(); };
}
const progress = (t) => { const p = $("#progress"); if (p) p.textContent = t; };
function fail(e) { progress(""); toast(e?.message || String(e)); }

// ---------- loading a repo into the in-memory filesystem ----------
const skipPath = (rel) => rel.split("/").some((seg, i, a) => IGNORED.has(seg) || (i < a.length - 1 && seg.startsWith(".")));

async function ingest(name, items) {
  core.vfsReset();
  ROOT = "/" + (String(name).replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "") || "repo");
  let n = 0;
  const keep = items.filter((it) => it.rel && !skipPath(it.rel)).slice(0, MAX_FILES);
  for (const it of keep) {
    let data = "";
    if (it.size <= MAX_TEXT && !BINARY.test(it.rel)) {
      const raw = await it.read();
      data = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      if (data.slice(0, 2000).includes("\u0000")) data = "";
    }
    core.vfsAdd(`${ROOT}/${it.rel}`, data, it.size);
    if (++n % 250 === 0) { progress(`Reading ${n.toLocaleString()} of ${keep.length.toLocaleString()} files…`); await new Promise((r) => setTimeout(r)); }
  }
  if (!n) throw new Error("No files found. Pick the folder that holds your tests (with pom.xml, package.json, requirements.txt or a .csproj).");
  S.repoName = name;
  S.loaded = n;
  analyze();
}

async function fromFileList(list) {
  S.source = null;
  const files = [...list];
  if (!files.length) return;
  progress(`Reading ${files.length.toLocaleString()} files…`);
  await ingest(files[0].webkitRelativePath.split("/")[0] || "repo", files.map((f) => ({ rel: f.webkitRelativePath.split("/").slice(1).join("/"), size: f.size, read: () => f.text() }))).catch(fail);
}

async function fromZip(file) {
  S.source = null;
  progress(`Unpacking ${file.name}…`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const entries = await new Promise((res, rej) => unzip(bytes, { filter: (f) => !f.name.endsWith("/") && !skipPath(f.name) && f.originalSize <= 8 * MAX_TEXT }, (err, out) => (err ? rej(err) : res(out))));
  const names = Object.keys(entries);
  // GitHub's "Download ZIP" wraps everything in one top folder (repo-main/): strip it and use it as the name
  const top = names.length && names.every((n) => n.includes("/") && n.split("/")[0] === names[0].split("/")[0]) ? names[0].split("/")[0] + "/" : "";
  await ingest(top ? top.slice(0, -1) : file.name.replace(/\.zip$/i, ""), names.map((n) => ({ rel: n.slice(top.length), size: entries[n].length, read: async () => entries[n] })));
}

async function fromDrop(dt) {
  const entries = [...(dt?.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (entries.length === 1 && entries[0].isFile && /\.zip$/i.test(entries[0].name)) return fromZip(await new Promise((r, j) => entries[0].file(r, j)));
  if (entries.length === 1 && entries[0].isDirectory) {
    progress("Listing files…");
    const items = [];
    const walk = async (dir, prefix) => {
      const reader = dir.createReader();
      for (;;) {
        const batch = await new Promise((r, j) => reader.readEntries(r, j));
        if (!batch.length) break;
        for (const e of batch) {
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory) { if (!IGNORED.has(e.name) && !e.name.startsWith(".")) await walk(e, rel); }
          else if (items.length < MAX_FILES) {
            const f = await new Promise((r, j) => e.file(r, j));
            items.push({ rel, size: f.size, read: () => f.text() });
          }
        }
      }
    };
    await walk(entries[0], "");
    return ingest(entries[0].name, items);
  }
  throw new Error("Drop one folder or one .zip file.");
}

async function loadSample(key) {
  S.source = null;
  const s = SAMPLES[key];
  await ingest(key, Object.entries(s.files).map(([rel, text]) => ({ rel, size: text.length, read: async () => text })));
}

// ---------- analysis & generation ----------
function analyze() {
  S.profile = core.analyzeRepo(ROOT);
  S.summary = core.summarizeProfile(S.profile, 40);
  S.scan = core.scanRepo(ROOT);
  Object.assign(S, { options: {}, history: [], chat: [], opt: null, diag: null, logs: "", capsResult: null, tab: "checks", view: "chat", fileName: null });
  regenerate();
  workspace();
  const w = welcome(context());
  const existing = (S.profile.existingHyperExecuteYamls || []).slice(0, 3);
  if (existing.length) {
    w.reply += `\n\nYour repo already has ${existing.map((f) => `\`${f}\``).join(", ")}. I can check and optimize that instead of starting fresh.`;
    w.chips.unshift(...existing.map((f) => ({ label: `Check my ${f.split("/").pop()}`, primary: true, run: () => loadExisting(f) })));
  }
  const usual = S.result && !S.pendingSetup ? loadUsual(S.result.framework) : null;
  if (usual && Object.keys(usual).length) w.chips.unshift({ label: `Use my usual: ${describeOptions(usual) || "settings"}`, primary: true, run: () => { const r = applyOptions(usual); renderAll(); say("bot", r.error ? `Your usual settings don't fit this repo: ${r.error}` : `Applied your usual settings. ${checkLine()}`, { chips: [{ label: "Undo", send: "undo", icon: "undo" }] }); } });
  say("bot", w.reply, { chips: w.chips });
  applyPendingSetup();
}

const credsOn = () => !!(S.lt.embed && S.lt.user.trim() && S.lt.key.trim());
function genOptions(extra = {}) {
  return { ...S.options, ...extra, outputFileName: "hyperexecute.yaml", embedCredentials: credsOn(), ltCredentials: credsOn() ? { username: S.lt.user.trim(), accessKey: S.lt.key.trim() } : undefined };
}
function regenerate() {
  try {
    const r = core.generateYaml(S.profile, genOptions());
    Object.assign(S, { result: r, yaml: r.yaml, generated: r.yaml, dirty: false, error: null });
  } catch (e) {
    S.error = visitor(e.message);
  }
  S.opt = null;
  validate();
}
function validate() {
  try { S.validation = core.validateYaml(S.yaml, ROOT); } catch (e) { S.validation = { valid: false, errors: [e.message], warnings: [], info: [] }; }
  try { S.parsed = core.YAML.parse(S.yaml.replace(/\$\{\{[^}]*\}\}/g, "x")) || {}; } catch { S.parsed = {}; }
}
function context() {
  return { core, profile: S.profile, summary: S.summary, result: S.result, yaml: S.yaml, validation: S.validation, parsed: S.parsed, scan: S.scan, repoName: S.repoName, credsOn: credsOn(), visitor, searchKb: (q) => searchKnowledge(q, 3) };
}
// generator notes speak to the VS Code / MCP flow; replace the account note with the web one
function notes() {
  const n = (S.result?.notes || []).filter((x) => !/^LT_USERNAME \/ LT_ACCESS_KEY/.test(x));
  n.unshift(credsOn()
    ? "LT_USERNAME / LT_ACCESS_KEY contain the account you entered. The file holds your access key, so don't commit it to a shared repo."
    : "LT_USERNAME / LT_ACCESS_KEY are secret references. Create both secrets in HyperExecute → Settings → Secrets, or add your account in Settings (gear icon) to fill them in.");
  return n.map(visitor);
}

// options changes, from the bar or the chat; returns the list of problems (empty = ok)
function snapshot() { S.history.push({ options: structuredClone(S.options), yaml: S.yaml, generated: S.generated, dirty: S.dirty }); if (S.history.length > 30) S.history.shift(); }
function applyOptions(patch) {
  const before = S.options;
  const next = { ...before };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete next[k];
    else if (k === "extraEnv" || k === "extraMatrix") next[k] = { ...(before[k] || {}), ...v };
    else next[k] = v;
  }
  if (next.executionMode === "matrix" && !next.yamlVersion) next.yamlVersion = "0.1";
  const hadEdits = S.dirty;
  snapshot();
  S.options = next;
  regenerate();
  if (S.error) {
    const err = S.error;
    undo(true);
    return { error: err };
  }
  saveUsual();
  return { hadEdits };
}
function undo(silent) {
  const h = S.history.pop();
  if (!h) return false;
  Object.assign(S, { options: h.options, yaml: h.yaml, generated: h.generated, dirty: h.dirty, error: null });
  try { S.result = core.generateYaml(S.profile, genOptions()); } catch {}
  validate();
  if (!silent) renderAll();
  return true;
}

// the repo's own HyperExecute YAML: validate and optimize it instead of generating a new one
function loadExisting(rel) {
  const text = core.vfsRead(`${ROOT}/${rel}`);
  if (!text) return say("bot", `I couldn't read \`${rel}\`.`, { error: true });
  snapshot();
  Object.assign(S, { yaml: text, dirty: true, fileName: rel.split("/").pop(), opt: null });
  validate();
  renderAll();
  const o = runOptimizer();
  const v = S.validation;
  const lines = [`Loaded **${rel}**. ${v.errors.length ? `It has **${plural(v.errors.length, "problem")}**:\n${v.errors.slice(0, 5).map((e) => `- ${visitor(e)}`).join("\n")}` : v.warnings.length ? `It's valid, with ${plural(v.warnings.length, "warning")} under Checks.` : "It's valid against HyperExecute's rules."}`];
  if (o.suggestions?.length) lines.push(`I also see ${plural(o.suggestions.length, "way")} to make it faster or cheaper.`);
  say("bot", lines.join("\n\n"), { chips: [o.suggestions?.length ? { label: "Optimize it", send: "Optimize it", primary: true } : null, { label: "Explain this YAML", send: "Explain this YAML" }, { label: "Use a freshly generated YAML", run: () => { undo(); say("bot", "Back to the YAML I generated from your repo."); } }].filter(Boolean) });
}

// a CI file that runs the YAML on every push
function pipelineInChat(ci) {
  if (ci === "ask") return say("bot", "Which CI do you use? I'll write the pipeline file that downloads the HyperExecute CLI and runs this YAML.", { chips: Object.entries(core.CI_SYSTEMS).map(([id, s]) => ({ label: s.name, run: () => pipelineInChat(id) })) });
  const p = core.generatePipeline({ ci, yaml: S.yaml });
  say("bot", `Here's **${p.path}** for ${p.name}. It downloads the CLI, runs this YAML with your LambdaTest account from the CI's secrets, fails the build when the job fails, and keeps the job logs.\n\n${p.notes.map((n) => `- ${n}`).join("\n")}`, {
    chips: [
      { label: `Download ${p.path.split("/").pop()}`, primary: true, icon: "download", run: () => download(p.path.split("/").pop(), p.content) },
      { label: "Copy", icon: "copy", run: () => copy(p.content, "Pipeline copied") },
      { label: "Preview in Run tab", run: () => { S.ci = ci; openTab("run"); } },
    ],
  });
}

// ---------- chat ----------
function say(role, text, extra = {}) {
  S.chat.push({ role, text, ...extra });
  renderChat();
}
const chipActions = new Map();
let chipSeq = 0;
function chip(c) {
  const id = `c${++chipSeq}`;
  chipActions.set(id, c);
  return `<button class="chip${c.primary ? " primary" : ""}" data-chip="${id}">${c.icon ? icon[c.icon] : ""}${esc(c.label)}</button>`;
}

async function send(text) {
  text = String(text || "").trim();
  if (!text || S.busy) return;
  say("me", text, { log: text.split("\n").length > 3 });
  const plan = respond(text, context());
  await act(plan, text);
}

async function act(plan, text) {
  if (plan.diagnose) return diagnoseInChat(plan.diagnose);
  if (plan.undo) return say("bot", undo() ? "Undone. The YAML is back to how it was." : "There's nothing to undo.");
  if (plan.reset) { snapshot(); S.options = {}; regenerate(); renderAll(); return say("bot", "Back to the detected defaults.", { chips: [{ label: "Undo", send: "undo", icon: "undo" }] }); }
  if (plan.optimize) return optimizeInChat();
  if (plan.pipeline) return pipelineInChat(plan.pipeline);
  if (plan.options) return changeInChat(plan.options, plan.done || [], plan.reply);
  if (plan.yaml) {
    snapshot();
    Object.assign(S, { yaml: plan.yaml, dirty: true });
    validate();
    renderAll();
    return say("bot", `${plan.reply || "I rewrote the YAML."}\n\n${checkLine()}`, { chips: [{ label: "Undo", send: "undo", icon: "undo" }], via: S.ai.on ? "Claude" : null });
  }
  if (plan.ai && S.ai.on && S.ai.key) return askAi(text);
  if (plan.tab) openTab(plan.tab);
  say("bot", plan.reply + (plan.ai && !S.ai.on && !S.aiHinted ? "\n\nFor free-form questions you can also connect Claude with your own API key in Settings." : ""), { chips: plan.chips });
  if (plan.ai) S.aiHinted = true;
}

// unfilled <set X> values are an expected last step, not a broken YAML: say what to do
const placeholders = () => (S.validation?.errors || []).map((e) => (e.match(/^env\.(\w+) still has a placeholder value/) || [])[1]).filter(Boolean);
function checkLine() {
  const v = S.validation;
  if (!v) return "";
  const todo = placeholders();
  if (todo.length && todo.length === v.errors.length) return `**Almost ready**: fill in ${todo.map((x) => `\`${x}\``).join(", ")}. Tell me, e.g. \`${todo[0]}=https://…\`.`;
  if (v.errors.length) return `**${plural(v.errors.length, "check")} failing**: ${visitor(v.errors[0])}${v.errors.length > 1 ? " (see Checks)" : ""}`;
  return v.warnings.length ? `The YAML is valid, with ${plural(v.warnings.length, "warning")} under Checks.` : "The YAML is valid.";
}

function changeInChat(patch, done, reply) {
  const oldLines = S.yaml.split("\n");
  const r = applyOptions(patch);
  if (r.error) return say("bot", `I couldn't apply that: ${r.error}`, { error: true });
  renderAll();
  const changed = S.yaml.split("\n").filter((l, i) => l !== oldLines[i]).length;
  const what = reply || `Done: ${done.join(" · ")}.`;
  const fill = placeholders().slice(0, 2).map((x) => ({ label: `Set ${x}`, prefill: `${x}=`, primary: true }));
  say("bot", `${what}${r.hadEdits ? "\n\nYour hand edits were replaced by the rebuilt YAML; say **undo** to get them back." : ""}\n\n${checkLine()}${changed ? "" : " Nothing in the YAML changed."}`, { chips: [...fill, { label: "Undo", send: "undo", icon: "undo" }, { label: "Explain this YAML", send: "Explain this YAML" }], via: reply && S.ai.on ? "Claude" : null });
  if (S.view === "chat" && window.innerWidth > 960) flashYaml();
}
function flashYaml() { const e = $(".editor"); if (!e) return; e.animate?.([{ boxShadow: "inset 0 0 0 2px var(--brand)" }, { boxShadow: "inset 0 0 0 0 transparent" }], { duration: 700 }); }

function optimizeInChat() {
  const o = runOptimizer();
  if (o.error) return say("bot", `I couldn't analyze this YAML: ${o.error}`, { error: true });
  if (!o.suggestions.length) return say("bot", "Nothing to optimize: this YAML already follows the recommendations.");
  const top = o.suggestions.filter((s) => s.severity !== "low");
  say("bot", `I found ${plural(o.suggestions.length, "improvement")}:\n${o.suggestions.map((s) => `- **${s.title.replace(/`/g, "")}** (${s.severity}): ${visitor(s.why)}`).join("\n")}`, {
    chips: [
      top.length ? { label: `Apply ${top.length === o.suggestions.length ? "all" : `the ${plural(top.length, "important one")}`}`, primary: true, run: () => applyOptimizationIds(top.map((s) => s.id)) } : null,
      { label: "Review in Optimize", run: () => openTab("optimize") },
    ].filter(Boolean),
  });
}

function diagnoseInChat(logText) {
  S.logs = logText;
  runDiagnosis();
  const { d, fixed, applied } = S.diag;
  const [, label] = STATUS[d.status] || ["", d.status];
  const lines = [`**${label}.**`];
  if (d.tests.failed) lines.push(`${d.tests.failed} of ${d.tests.total} tests failed: ${d.tests.code} from the test code (left alone), ${d.tests.yaml} from the YAML or environment.`);
  for (const x of d.diagnoses.slice(0, 4)) lines.push(`- **${x.title}**: ${visitor(x.why)}${x.fixSummary ? ` Fix: ${x.fixSummary}.` : ""}`);
  if (d.needsValue?.length) lines.push(`The tests need values for ${d.needsValue.map((v) => `\`${v}\``).join(", ")}; tell me, e.g. \`${d.needsValue[0]}=…\`.`);
  if (!d.diagnoses.length && !d.tests.failed) lines.push("No known failure pattern matched. The lines that look like errors are in the Diagnose tab.");
  const chips = [];
  if (fixed) chips.push({ label: "Use the corrected YAML", primary: true, icon: "check", run: () => useFixedYaml() });
  chips.push({ label: "Details", run: () => openTab("diagnose") });
  say("bot", lines.join("\n") + (fixed ? `\n\nI prepared a corrected YAML (${applied.join("; ")}).` : ""), { chips });
}

async function askAi(text) {
  S.busy = true;
  renderChat();
  try {
    const { askClaude } = await import("./claude.js");
    const ctx = {
      repo: { name: S.repoName, language: S.summary.language, frameworks: S.summary.frameworks, buildTool: S.summary.buildTool || S.summary.packageManager, tests: S.summary.tests, confidence: S.summary.confidence, questions: S.summary.questions, mavenProfiles: S.profile.mavenProfiles, playwrightProjects: S.profile.playwrightProjects, envVars: S.summary.envVars },
      options: S.options,
      yaml: S.yaml,
      checks: { errors: S.validation?.errors, warnings: S.validation?.warnings },
      scan: S.scan?.summary,
    };
    const history = S.chat.slice(0, -1).filter((m) => (m.role === "me" || m.role === "bot") && !m.log).map((m) => ({ role: m.role === "me" ? "user" : "assistant", text: m.text }));
    const plan = await askClaude({ apiKey: S.ai.key, context: ctx, history, text });
    S.busy = false;
    if (plan.options) return changeInChat(plan.options, [], plan.reply);
    await act(plan, text);
    const last = S.chat.at(-1);
    if (last && last.role === "bot") { last.via = "Claude"; renderChat(); }
  } catch (e) {
    S.busy = false;
    say("bot", `Claude couldn't answer: ${e?.status === 401 ? "the API key was rejected" : e?.message || e}. The built-in assistant still works.`, { error: true });
  }
}

function renderChat() {
  const box = $("#msgs");
  if (!box) return;
  box.innerHTML = S.chat.map((m) => {
    if (m.role === "me") return `<div class="msg me"><div class="body${m.log ? " log" : ""}">${esc(m.text)}</div></div>`;
    return `<div class="msg bot${m.error ? " error" : ""}"><div class="av">${icon.bolt}</div><div class="body">${md(m.text)}${m.chips?.length ? `<div class="chips">${m.chips.map(chip).join("")}</div>` : ""}${m.via ? `<div class="meta">via ${esc(m.via)}</div>` : ""}</div></div>`;
  }).join("") + (S.busy ? `<div class="msg bot"><div class="av">${icon.bolt}</div><div class="body"><span class="typing"><i></i><i></i><i></i></span></div></div>` : "");
  $$("[data-chip]", box).forEach((b) => (b.onclick = () => {
    const c = chipActions.get(b.dataset.chip);
    if (!c) return;
    if (c.run) return c.run();
    if (c.prefill) { const t = $("#input"); t.value = c.prefill; t.focus(); autosize(); return; }
    if (c.send) send(c.send);
  }));
  box.scrollTop = box.scrollHeight;
  $("#send").disabled = S.busy;
  const ai = $("#aiChip");
  if (ai) { ai.className = `ai-chip${S.ai.on ? " on" : ""}`; ai.innerHTML = `${S.ai.on ? icon.sparkle : icon.bolt}${S.ai.on ? "Claude" : "Built-in assistant"}`; }
}
function autosize() { const t = $("#input"); if (!t) return; t.style.height = "auto"; t.style.height = Math.min(180, t.scrollHeight) + "px"; }

// ---------- workspace ----------
function setView(v) {
  S.view = v;
  const ws = $(".ws");
  if (ws) ws.dataset.view = v;
  $$("#views button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
}
function workspace() {
  $("#newRepo").classList.remove("hidden");
  $("#views").classList.remove("hidden");
  $("#privacy").classList.add("hidden");
  const p = S.summary;
  $("#view").innerHTML = `
    <div class="ws" data-view="${S.view}">
      <aside class="chat" aria-label="Assistant">
        <div class="chat-h">
          <div class="repo"><b>${esc(S.repoName)}</b><span>${esc(stackLine(p, S.result?.framework))} · ${plural(S.loaded, "file")}</span></div>
          <span class="spacer"></span>
          <button class="ai-chip" id="aiChip" title="Change in Settings"></button>
        </div>
        <div class="msgs" id="msgs" aria-live="polite"></div>
        <div class="composer">
          <div class="box">
            <textarea id="input" rows="1" placeholder="Ask, or describe what you need… (paste a job log to diagnose it)" aria-label="Message"></textarea>
            <button class="btn primary" id="send" aria-label="Send">${icon.send}</button>
          </div>
          <div class="hint"><span>Enter to send · Shift+Enter for a new line</span><button class="link small" id="helpLink">What can I ask?</button></div>
        </div>
      </aside>
      <section class="work">
        <div class="optbar" id="optbar"></div>
        <div class="editor-card">
          <div class="ed-h">
            <span class="fname" id="fname">hyperexecute.yaml</span><span class="ver" id="ver"></span><span class="edited" id="edited"></span>
            <span class="spacer"></span>
            <button class="status" id="statusPill"></button>
            <button class="btn sm quiet" id="shareBtn" title="Copy a link with these settings (never your code)">${icon.share}Share</button>
            <button class="btn sm" id="copyBtn">${icon.copy}Copy</button>
            <button class="btn sm primary" id="dlBtn">${icon.download}Download</button>
          </div>
          <div id="genErr"></div>
          <div class="editor">
            <div class="gutter" id="gutter" aria-hidden="true">1</div>
            <div class="code"><pre id="hl" aria-hidden="true"></pre><textarea id="yaml" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="HyperExecute YAML"></textarea></div>
          </div>
        </div>
        <div class="drawer">
          <nav class="tabs" id="tabs" role="tablist"></nav>
          <div class="panel" id="panel" role="tabpanel"></div>
        </div>
      </section>
    </div>`;
  setView(S.view);
  $("#aiChip").onclick = () => openSettings();
  $("#helpLink").onclick = () => { const h = help(); say("bot", h.reply, { chips: h.chips }); };
  $("#copyBtn").onclick = () => copy(S.yaml, "YAML copied");
  $("#shareBtn").onclick = () => copy(shareLink(), S.source ? "Link copied — it opens this repo with these settings" : "Link copied — the other person loads the same repo and gets these settings");
  $("#dlBtn").onclick = () => download(S.fileName || "hyperexecute.yaml", S.yaml, "text/yaml");
  $("#statusPill").onclick = () => { openTab("checks"); if (window.innerWidth <= 960) setView("checks"); };
  const input = $("#input");
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); const v = input.value; input.value = ""; autosize(); send(v); } });
  input.addEventListener("input", autosize);
  $("#send").onclick = () => { const v = input.value; input.value = ""; autosize(); send(v); };
  const ta = $("#yaml");
  let t;
  ta.addEventListener("input", () => {
    S.yaml = ta.value;
    S.dirty = S.yaml !== S.generated;
    paintEditor(false);
    clearTimeout(t);
    t = setTimeout(() => { S.opt = null; validate(); renderMeta(); renderTabs(); if (S.tab === "checks") renderPanel(); }, 300);
  });
  ta.addEventListener("scroll", () => { $("#hl").scrollTop = ta.scrollTop; $("#hl").scrollLeft = ta.scrollLeft; $("#gutter").scrollTop = ta.scrollTop; });
  ta.addEventListener("keydown", (e) => { if (e.key === "Tab") { e.preventDefault(); ta.setRangeText("  ", ta.selectionStart, ta.selectionEnd, "end"); ta.dispatchEvent(new Event("input")); } });
  document.addEventListener("keydown", (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && $("#input")) { e.preventDefault(); setView("chat"); $("#input").focus(); } });
  renderAll();
}

function renderAll() {
  renderOptions();
  paintEditor(true);
  renderMeta();
  renderTabs();
  renderPanel();
  renderChat();
}

function paintEditor(setValue) {
  const ta = $("#yaml");
  if (!ta) return;
  if (setValue && ta.value !== S.yaml) ta.value = S.yaml;
  $("#hl").innerHTML = highlightYaml(ta.value);
  const n = ta.value.split("\n").length;
  $("#gutter").textContent = Array.from({ length: n }, (_, i) => i + 1).join("\n");
  $("#hl").scrollTop = ta.scrollTop;
}
function renderMeta() {
  $("#fname").textContent = S.fileName || "hyperexecute.yaml";
  $("#ver").textContent = S.result ? `v${S.result.yamlVersion} · ${fwName(S.result.framework)}` : "";
  $("#edited").textContent = S.dirty ? "Edited" : "";
  const v = S.validation;
  const pill = $("#statusPill");
  const todo = placeholders();
  const [cls, ic, txt] = !v ? ["warn", "alert", "No YAML"] : todo.length && todo.length === v.errors.length ? ["warn", "alert", `Fill in ${plural(todo.length, "value")}`] : v.errors.length ? ["err", "x", plural(v.errors.length, "error")] : v.warnings.length ? ["warn", "alert", plural(v.warnings.length, "warning")] : ["ok", "check", "Valid"];
  pill.className = `status ${cls}`;
  pill.innerHTML = `${icon[ic]}${txt}`;
  $("#genErr").innerHTML = S.error ? `<div class="gen-err">${esc(S.error)}</div>` : "";
}

function renderOptions() {
  const o = S.options;
  const r = S.result || {};
  const splits = r.supportedSplits || ["class"];
  const sel = (id, label, opts, val) => `<label class="ctl"><span>${label}</span><select id="${id}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(val) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;
  const retries = o.retryOnFailure === false ? 0 : o.maxRetries ?? 1;
  const mvn = S.profile.mavenProfiles || [];
  const conc = o.concurrency ?? 5;
  $("#optbar").innerHTML =
    sel("o-os", "Runs on", Object.entries(OS_NAME), o.runson || "linux") +
    `<div class="ctl"><span>Parallel VMs</span><div class="stepper"><button id="c-minus" aria-label="Fewer VMs">−</button><input type="number" id="o-conc" value="${conc}" min="1" max="500" aria-label="Parallel VMs"><button id="c-plus" aria-label="More VMs">+</button></div></div>` +
    sel("o-split", "Split by", splits.map((s) => [s, s[0].toUpperCase() + s.slice(1)]), o.splitBy || r.splitBy || splits[0]) +
    sel("o-mode", "Mode", [["autosplit", "Autosplit"], ["matrix", "Matrix"]], o.executionMode || r.executionMode || "autosplit") +
    sel("o-retry", "Retries", [0, 1, 2, 3, 4, 5].map((n) => [n, n ? String(n) : "None"]), retries) +
    sel("o-timeout", "Timeout", [30, 60, 90, 120, 150].map((n) => [n, `${n} min`]).concat(o.globalTimeout && ![30, 60, 90, 120, 150].includes(o.globalTimeout) ? [[o.globalTimeout, `${o.globalTimeout} min`]] : []), o.globalTimeout ?? 90) +
    sel("o-ver", "YAML", [["auto", `Auto (v${r.yamlVersion || "…"})`], ["0.2", "v0.2 native"], ["0.1", "v0.1 raw"]], o.yamlVersion || "auto") +
    (mvn.length ? sel("o-mvnp", "Maven profile", [["", "None"], ...mvn.map((m) => [m.id, m.id + (m.activeByDefault ? " (default)" : "")])], o.mavenProfile || "") : "") +
    `<label class="switch"><input type="checkbox" id="o-tunnel" ${o.tunnel ? "checked" : ""}><span class="track"></span>Tunnel</label>` +
    `<button class="btn quiet sm reset" id="resetOpts" title="Back to the detected defaults">${icon.refresh}Reset</button>`;
  const set = (patch) => {
    const r2 = applyOptions(patch);
    if (r2.error) toast(r2.error);
    else if (r2.hadEdits) toast("Rebuilt from the options — your hand edits are one Undo away (say “undo” in chat)");
    renderAll();
  };
  $("#o-os").onchange = (e) => set({ runson: e.target.value });
  $("#o-split").onchange = (e) => set({ splitBy: e.target.value });
  $("#o-mode").onchange = (e) => set({ executionMode: e.target.value, yamlVersion: e.target.value === "matrix" ? "0.1" : o.yamlVersion ?? null });
  $("#o-retry").onchange = (e) => { const n = +e.target.value; set(n ? { retryOnFailure: true, maxRetries: n } : { retryOnFailure: false, maxRetries: null }); };
  $("#o-timeout").onchange = (e) => set({ globalTimeout: +e.target.value });
  $("#o-ver").onchange = (e) => set({ yamlVersion: e.target.value === "auto" ? null : e.target.value });
  if ($("#o-mvnp")) $("#o-mvnp").onchange = (e) => set({ mavenProfile: e.target.value || null });
  $("#o-tunnel").onchange = (e) => set({ tunnel: e.target.checked || null });
  $("#resetOpts").onclick = () => { snapshot(); S.options = {}; regenerate(); renderAll(); };
  let t;
  const concSet = (n) => { n = Math.max(1, Math.min(500, n || 1)); $("#o-conc").value = n; clearTimeout(t); t = setTimeout(() => set({ concurrency: n }), 350); };
  $("#c-minus").onclick = () => concSet(+$("#o-conc").value - 1);
  $("#c-plus").onclick = () => concSet(+$("#o-conc").value + 1);
  $("#o-conc").oninput = (e) => concSet(+e.target.value);
}

// ---------- drawer tabs ----------
const TABS = [["checks", "Checks", "list"], ["run", "Run", "play"], ["optimize", "Optimize", "wand"], ["security", "Security", "shield"], ["diagnose", "Diagnose", "pulse"], ["grid", "Grid", "grid"]];
function openTab(id) {
  S.tab = id;
  renderTabs();
  renderPanel();
}
function renderTabs() {
  const v = S.validation;
  const count = {
    checks: v ? (v.errors.length ? `<span class="count ${placeholders().length === v.errors.length ? "warn" : "err"}">${v.errors.length}</span>` : v.warnings.length ? `<span class="count warn">${v.warnings.length}</span>` : `<span class="count ok">✓</span>`) : "",
    security: S.scan?.credentials?.length ? `<span class="count err">${S.scan.credentials.length}</span>` : S.scan?.reporting?.length ? `<span class="count warn">${S.scan.reporting.length}</span>` : "",
    optimize: S.opt?.suggestions?.length ? `<span class="count warn">${S.opt.suggestions.length}</span>` : "",
  };
  $("#tabs").innerHTML = TABS.map(([id, label, ic]) => `<button class="tab${S.tab === id ? " on" : ""}" role="tab" aria-selected="${S.tab === id}" data-tab="${id}">${icon[ic]}${label}${count[id] || ""}</button>`).join("");
  $$("#tabs .tab").forEach((b) => (b.onclick = () => openTab(b.dataset.tab)));
}
const item = (cls, ic, text) => `<div class="item ${cls}">${icon[ic]}<span>${inline(visitor(text))}</span></div>`;
function renderPanel() {
  const el = $("#panel");
  if (!el) return;
  ({ checks: renderChecks, run: renderRun, optimize: renderOptimize, security: renderSecurity, diagnose: renderDiagnose, grid: renderGrid })[S.tab](el);
}

function renderChecks(el) {
  const v = S.validation;
  const warns = (S.summary.warnings || []).map(visitor);
  const todo = placeholders();
  const onlyTodo = todo.length && todo.length === v.errors.length;
  el.innerHTML =
    (onlyTodo ? `<p class="lead-line warn">${icon.alert}Almost ready: fill in ${todo.join(", ")}</p>` : v.errors.length ? `<p class="lead-line err">${icon.x}${plural(v.errors.length, "check")} failing</p>` : `<p class="lead-line ok">${icon.check}${v.warnings.length ? "Valid, with things to look at" : "Valid against HyperExecute's rules"}</p>`) +
    (v.errors.length || v.warnings.length ? `<div class="group">${v.errors.map((e) => { const m = e.match(/^env\.(\w+) still has a placeholder value/); return m ? item("warn", "alert", `Set \`${m[1]}\`: your tests read it. Type \`${m[1]}=…\` in the chat, or edit the YAML.`) : item("err", "x", e); }).join("")}${v.warnings.map((e) => item("warn", "alert", e)).join("")}</div>` : "") +
    `<div class="group"><h4>About this YAML</h4>${notes().map((n) => item("info", "info", n)).join("")}${(v.info || []).map((n) => item("info", "info", n)).join("")}</div>` +
    (warns.length ? `<div class="group"><h4>About your repo</h4>${warns.map((w) => item("warn", "alert", w)).join("")}</div>` : "");
}

function renderRun(el) {
  const pipe = core.generatePipeline({ ci: S.ci || "github", yaml: S.yaml });
  const r = S.result || {};
  const d = S.parsed || {};
  const cmd = d.testDiscovery?.command;
  const t = S.summary.tests;
  const expected = { class: t.classCount, method: t.methodCount, file: t.fileCount, feature: t.featureCount, scenario: t.scenarioCount, tag: (t.tags || []).length }[r.splitBy];
  const os = S.runOs;
  const run = os === "win"
    ? `set LT_USERNAME=<your username>\nset LT_ACCESS_KEY=<your access key>\nhyperexecute.exe --user "%LT_USERNAME%" --key "%LT_ACCESS_KEY%" --config hyperexecute.yaml`
    : `chmod +x hyperexecute\nexport LT_USERNAME="${credsOn() ? S.lt.user.trim() : "<your username>"}"\nexport LT_ACCESS_KEY="<your access key>"\n./hyperexecute --user "$LT_USERNAME" --key "$LT_ACCESS_KEY" --config hyperexecute.yaml`;
  el.innerHTML = `
    <ol class="steps">
      <li><div><b>Save the YAML at the root of your repo</b><span class="muted">as hyperexecute.yaml.</span><div class="mt"><button class="btn sm" id="runDl">${icon.download}Download hyperexecute.yaml</button></div></div></li>
      ${r.yamlVersion === "0.2"
        ? `<li><div><b>Discovery happens on HyperExecute</b><span class="muted">YAML v0.2 finds the tests itself. On the first job, check the discovery log shows ${expected ? `about ${plural(expected, `${r.splitBy || "test"} unit`)}` : "the test units you expect"}.</span></div></li>`
        : cmd ? `<li><div><b>Preview what will be split</b><span class="muted">Run this in your repo. It should print one ${esc(r.splitBy || "test")} per line${expected ? `, about ${expected} here` : ""}. If it prints nothing, fix the paths before running.</span><pre class="block">${esc(cmd)}</pre><button class="btn sm" id="cpDisc">${icon.copy}Copy command</button></div></li>` : ""}
      <li><div><b>Credentials</b><span class="muted">${credsOn() ? "Your username and key are in the YAML. Don't commit that file to a shared repo." : "The YAML uses secret references. Create LT_USERNAME and LT_ACCESS_KEY under HyperExecute → Settings → Secrets, or add your account in Settings here."}</span></div></li>
      <li><div><b>Download the HyperExecute CLI and run</b>
        <div class="row mt"><select id="runOs" aria-label="Your operating system">${[["mac", "macOS"], ["linux", "Linux"], ["win", "Windows"]].map(([v, l]) => `<option value="${v}" ${v === os ? "selected" : ""}>${l}</option>`).join("")}</select>
        <a class="btn sm primary" href="${esc(core.cliDownloadUrl(os))}" rel="noopener">${icon.download}Download CLI</a></div>
        <pre class="block">${esc(run)}</pre><button class="btn sm" id="cpRun">${icon.copy}Copy commands</button></div></li>
      <li><div><b>Or run it from your CI</b><span class="muted">A pipeline file that runs this YAML on every push, with your account taken from the CI's secrets.</span>
        <div class="row mt"><select id="ciSel" aria-label="CI system">${Object.entries(core.CI_SYSTEMS).map(([id, s]) => `<option value="${id}" ${id === (S.ci || "github") ? "selected" : ""}>${s.name}</option>`).join("")}</select>
        <button class="btn sm primary" id="ciDl">${icon.download}Download</button><button class="btn sm" id="ciCp">${icon.copy}Copy</button></div>
        <details class="mt"><summary class="small muted">${esc(pipe.path)}</summary><pre class="block scroll">${esc(pipe.content)}</pre></details>
        <div class="small muted">${pipe.notes.map(esc).join(" ")}</div></div></li>
      <li><div><b>If the job fails</b><span class="muted">Paste its log into the chat (or the Diagnose tab) to get the cause and a corrected YAML.</span></div></li>
    </ol>`;
  $("#runDl").onclick = () => download("hyperexecute.yaml", S.yaml, "text/yaml");
  if ($("#cpDisc")) $("#cpDisc").onclick = () => copy(cmd, "Command copied");
  $("#cpRun").onclick = () => copy(run, "Commands copied");
  $("#runOs").onchange = (e) => { S.runOs = e.target.value; renderRun(el); };
  $("#ciSel").onchange = (e) => { S.ci = e.target.value; renderRun(el); };
  $("#ciDl").onclick = () => download(pipe.path.split("/").pop(), pipe.content);
  $("#ciCp").onclick = () => copy(pipe.content, "Pipeline copied");
  $("#ciSel").style.width = "auto";
  $("#runOs").style.width = "auto";
}

function runOptimizer() {
  if (!S.opt) {
    try {
      const r = core.optimizeYaml(S.yaml, { profile: S.profile, repoPath: ROOT });
      S.opt = r.error ? { error: r.error, suggestions: [] } : { units: r.units, suggestions: core.describeSuggestions(r.suggestions) };
    } catch (e) { S.opt = { error: e.message, suggestions: [] }; }
  }
  return S.opt;
}
function applyOptimizationIds(ids) {
  if (!ids.length) return;
  snapshot();
  let { yaml, applied, regenerate: regen } = core.applyOptimizations(S.yaml, ids, { profile: S.profile, repoPath: ROOT });
  if (Object.keys(regen).length) { Object.assign(S.options, regen); yaml = core.generateYaml(S.profile, genOptions()).yaml; }
  Object.assign(S, { yaml, dirty: yaml !== S.generated, opt: null });
  validate();
  renderAll();
  say("bot", `Applied ${plural(applied.length || ids.length, "improvement")}. ${checkLine()}`, { chips: [{ label: "Undo", send: "undo", icon: "undo" }] });
}
function renderOptimize(el) {
  const o = runOptimizer();
  renderTabs();
  if (o.error) return (el.innerHTML = item("err", "x", o.error));
  if (!o.suggestions.length) return (el.innerHTML = `<p class="lead-line ok">${icon.check}Nothing to optimize — this YAML already follows the recommendations.</p>`);
  el.innerHTML = `<p class="muted small">${o.units ? `${o.units} test units to split. ` : ""}Pick what to apply:</p>` +
    `<ul class="cards">${o.suggestions.map((s) => `<li><label class="opt"><input type="checkbox" value="${esc(s.id)}" ${s.severity !== "low" ? "checked" : ""}><span><span class="sev ${esc(s.severity)}">${esc(s.severity)}</span><b>${inline(s.title)}</b><div class="muted small">${inline(visitor(s.why))}</div></span></label></li>`).join("")}</ul>` +
    `<button class="btn primary" id="optApply">${icon.wand}Apply selected</button>`;
  $("#optApply").onclick = () => applyOptimizationIds($$(".opt input:checked", el).map((i) => i.value));
}

function renderSecurity(el) {
  const { credentials: creds, reporting: rep } = S.scan;
  const auto = creds.filter((c) => c.autoFix).length;
  el.innerHTML =
    `<p class="lead-line ${creds.length ? "err" : "ok"}">${creds.length ? icon.alert : icon.shield}${creds.length ? `${plural(creds.length, "hard-coded LambdaTest credential")} in your code` : "No hard-coded LambdaTest credentials"}</p>` +
    (creds.length ? `<ul class="cards">${creds.map((c) => `<li><code>${esc(c.file)}:${c.line}</code> <span class="pill">${esc(c.kind)}</span> <code>${esc(c.value || `${c.username}:${c.accessKey}`)}</code>${c.autoFix ? "" : ` <span class="pill warn">edit by hand</span>`}</li>`).join("")}</ul>` +
      (auto ? `<div class="row"><button class="btn primary" id="fixDl">${icon.download}Download ${plural(auto, "fixed file")} (.zip)</button><span class="muted small">They read LT_USERNAME / LT_ACCESS_KEY from the environment instead.</span></div>` : "") : "") +
    `<p class="lead-line ${rep.length ? "warn" : "ok"} mt">${rep.length ? icon.alert : icon.check}${rep.length ? `${plural(rep.length, "place")} send results outside HyperExecute` : "Nothing sends results outside HyperExecute"}</p>` +
    (rep.length ? `<ul class="cards">${rep.map((r) => `<li><b>${esc(r.name)}</b> <code>${esc(r.file)}:${r.line}</code><div class="muted small">${esc(visitor(r.why))} <i>${esc(visitor(r.fix || ""))}</i></div></li>`).join("")}</ul>` : "");
  if ($("#fixDl")) $("#fixDl").onclick = () => {
    const plans = core.planCredentialFixes(ROOT, core.scanCredentials(ROOT));
    download(`${S.repoName}-credential-fixes.zip`, zipSync(Object.fromEntries(plans.map((p) => [p.file, strToU8(p.after)]))), "application/zip");
    toast(`${plural(plans.length, "file")} ready — copy them over your repo`);
  };
}

const STATUS = {
  passed: ["ok", "The run passed"],
  "passed-with-failures": ["warn", "The run finished with failed tests"],
  fixable: ["warn", "This is fixable in the YAML"],
  "fixable-tests": ["warn", "Some tests failed because of the YAML or environment"],
  "needs-input": ["warn", "The tests need an environment value"],
  "test-failures": ["err", "The tests themselves failed — not a YAML problem"],
  "auth-error": ["err", "The LambdaTest login failed"],
  "needs-attention": ["warn", "This needs a closer look"],
  unknown: ["err", "I don't recognize this failure"],
};
function runDiagnosis() {
  const text = S.logs || "";
  const d = core.diagnose({ evidence: core.collectEvidence({ output: text }), yamlText: S.yaml, profile: S.profile, exitCode: 1, v02Name: core.v02FrameworkName(S.profile, S.profile.primaryFramework) });
  const out = { d: core.describeDiagnosis(d), fixed: null, applied: [] };
  if (d._fixes.length) {
    const r = core.applyDiagnosisFixes(S.yaml, d);
    let next = r.yaml;
    if (Object.keys(r.options).length) next = core.applyDiagnosisFixes(core.generateYaml(S.profile, genOptions(r.options)).yaml, d, d._fixes.filter((f) => f.patch).map((f) => f.id)).yaml;
    if (next !== S.yaml) Object.assign(out, { fixed: next, applied: r.applied });
  }
  if (!d.diagnoses.length && !d.tests.failed) out.digest = core.logDigest(text, 3000);
  S.diag = out;
}
function useFixedYaml() {
  if (!S.diag?.fixed) return;
  snapshot();
  Object.assign(S, { yaml: S.diag.fixed, dirty: S.diag.fixed !== S.generated });
  validate();
  renderAll();
  say("bot", `Done: the corrected YAML is in the editor. Download it and run the job again. ${checkLine()}`, { chips: [{ label: "Undo", send: "undo", icon: "undo" }] });
}
function renderDiagnose(el) {
  el.innerHTML = `
    <p class="muted small">Paste the log of a failed job (HyperExecute dashboard or CLI output), or pick log files. It's checked against the YAML in the editor. You can also paste a log straight into the chat.</p>
    <textarea class="logs" id="logs" placeholder="Paste the job log here…" aria-label="Job log">${esc(S.logs)}</textarea>
    <div class="row mt"><button class="btn primary" id="diagGo">${icon.pulse}Diagnose</button><button class="btn" id="diagFile">${icon.folder}Pick log files or .zip</button><input type="file" id="logFiles" multiple accept=".log,.txt,.json,.xml,.zip" class="hidden"></div>
    <div id="diagOut" class="mt"></div>`;
  $("#logs").oninput = (e) => (S.logs = e.target.value);
  $("#diagGo").onclick = () => { if (!S.logs.trim()) return toast("Paste a job log first"); runDiagnosis(); renderDiagOut(); };
  $("#diagFile").onclick = () => $("#logFiles").click();
  $("#logFiles").onchange = async (e) => {
    let text = "";
    for (const f of e.target.files) {
      if (/\.zip$/i.test(f.name)) {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const out = await new Promise((res, rej) => unzip(bytes, { filter: (x) => /\.(log|txt|json|xml)$/i.test(x.name) && x.originalSize < 4e6 }, (er, o) => (er ? rej(er) : res(o))));
        for (const [n, b] of Object.entries(out)) text += `\n===== ${n} =====\n${new TextDecoder().decode(b)}`;
      } else text += `\n===== ${f.name} =====\n${await f.text()}`;
    }
    S.logs = text.slice(-4e6);
    $("#logs").value = S.logs;
    runDiagnosis();
    renderDiagOut();
  };
  if (S.diag) renderDiagOut();
}
function renderDiagOut() {
  const { d, fixed, applied, digest } = S.diag;
  const [cls, label] = STATUS[d.status] || ["warn", d.status];
  const t = d.tests;
  $("#diagOut").innerHTML =
    `<p class="lead-line ${cls}">${icon[cls === "ok" ? "check" : cls === "err" ? "x" : "alert"]}${esc(label)}</p>` +
    (t.failed ? `<p class="small">${t.failed} failed of ${t.total}: ${t.code} test code (left alone) · ${t.yaml} YAML/environment${t.unknown ? ` · ${t.unknown} unrecognized` : ""}</p>` : "") +
    (d.diagnoses.length ? `<ul class="cards">${d.diagnoses.map((x) => `<li><b>${esc(x.title)}</b><div class="muted small">${esc(visitor(x.why))}</div>${x.fixSummary ? `<div class="small okc">→ ${esc(x.fixSummary)}</div>` : ""}${x.advice ? `<div class="small">${esc(visitor(x.advice))}</div>` : ""}${x.evidence ? `<details><summary class="small muted">Evidence</summary><pre class="block">${esc(x.evidence)}</pre></details>` : ""}</li>`).join("")}</ul>` : "") +
    (d.needsValue?.length ? item("warn", "alert", `The tests need values for ${d.needsValue.join(", ")}. Add them under env: in the YAML, or tell the assistant.`) : "") +
    (fixed ? `<p class="small mt"><b>Corrected YAML</b>: ${esc(applied.join("; "))}</p><pre class="block scroll">${esc(fixed)}</pre><button class="btn primary" id="useFix">${icon.check}Use this YAML</button>` : "") +
    (digest ? `<p class="small muted">No known failure pattern matched. The lines that look like errors:</p><pre class="block scroll">${esc(digest)}</pre>` : "");
  if ($("#useFix")) $("#useFix").onclick = useFixedYaml;
}

// Grid: LambdaTest capabilities for the repo's language (live lists from LambdaTest's public API)
function renderGrid(el) {
  const c = S.caps;
  const L = S.capsLists || { browsers: [c.browser], versions: [c.version], platforms: [c.platform], resolutions: [c.resolution], live: false };
  const sel = (id, label, list, val) => `<label>${label}<select id="${id}">${list.map((v) => `<option ${v === val ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`;
  const tog = (k, label) => `<label class="switch"><input type="checkbox" data-k="${k}" ${c[k] ? "checked" : ""}><span class="track"></span>${label}</label>`;
  const r = S.capsResult;
  el.innerHTML = `
    <p class="muted small">Where your tests connect to a browser, and what to change there to run on the LambdaTest grid. ${S.capsLists ? (L.live ? "Browser and OS lists are live from LambdaTest." : "Offline lists: LambdaTest couldn't be reached.") : "Loading browser lists…"}</p>
    <div class="fields">${sel("c-browser", "Browser", L.browsers, c.browser)}${sel("c-version", "Version", L.versions, c.version)}${sel("c-platform", "Operating system", L.platforms, c.platform)}${sel("c-resolution", "Resolution", L.resolutions, c.resolution)}</div>
    <div class="row mt">${tog("video", "Video")}${tog("network", "Network logs")}${tog("console", "Console logs")}${tog("visual", "Screenshots")}${tog("tunnel", "Tunnel")}${tog("headless", "Headless")}</div>
    ${r ? gridChanges(r) : ""}`;
  for (const k of ["browser", "version", "platform"]) $(`#c-${k}`).onchange = (e) => { c[k] = e.target.value; loadCaps(true); };
  $("#c-resolution").onchange = (e) => { c.resolution = e.target.value; loadCaps(false); };
  $$("input[data-k]", el).forEach((i) => (i.onchange = () => { c[i.dataset.k] = i.checked; loadCaps(false); }));
  $$("[data-cap-copy]", el).forEach((b) => (b.onclick = () => copy(gridBlocks(r)[+b.dataset.capCopy].code, "Code copied")));
  if (!S.capsLists) loadCaps(true);
}
// the change for each place the repo connects; with none found, the code to use where the driver is created
const gridBlocks = (r) => {
  const withCode = (r.points || []).filter((p) => p.code);
  return withCode.length ? withCode.slice(0, 6) : [{ change: "Use this where your tests create their driver.", code: r.snippet.replace(/\bDRIVER\b/g, "driver") }];
};
function gridChanges(r) {
  const points = r.points || [];
  const onLT = points.filter((p) => p.usesLambdaTest).length;
  const where = points.length
    ? `<p class="small mt"><b>Where your tests connect</b> · ${points.length} place${points.length === 1 ? "" : "s"}, ${onLT ? `${onLT} already on LambdaTest` : "none on LambdaTest yet"}</p><ul class="cards">${points.slice(0, 12).map((s) => `<li class="small"><code>${esc(s.file)}:${s.line}</code> <span class="pill">${esc(s.kind)}</span> ${s.usesLambdaTest ? `<span class="pill ok">LambdaTest</span>` : `<span class="pill warn">not LambdaTest</span>`}<div><code>${esc(s.current)}</code></div></li>`).join("")}</ul>`
    : `<p class="small mt muted">${["cypress", "testcafe"].includes(r.framework) ? "This framework runs its browsers on the HyperExecute VM; there is no grid connection to change." : "No browser or device connection found. Look in your base class, hooks or config for where the driver is created."}</p>`;
  const changes = gridBlocks(r).map((p, i) => `<div class="mt"><p class="small">${p.file ? `<code>${esc(p.file)}:${p.line}</code> ` : ""}${esc(p.change)}</p><pre class="block scroll">${esc(p.code)}</pre>${p.imports ? `<p class="small muted">Imports, if missing: ${esc(p.imports.join(", "))}</p>` : ""}<div class="row"><button class="btn" data-cap-copy="${i}">${icon.copy}Copy</button></div></div>`).join("");
  return `${where}<p class="small mt"><b>What to change</b> <span class="muted">(in your own files; nothing new to add)</span></p>${changes}`;
}
let capsSeq = 0;
async function loadCaps(refreshLists) {
  const seq = ++capsSeq;
  if (refreshLists) {
    try {
      const L = await core.capabilityOptions(S.caps);
      if (seq !== capsSeq) return;
      S.capsLists = L;
      Object.assign(S.caps, { browser: L.browser, platform: L.platform });
      if (!L.versions.includes(S.caps.version)) S.caps.version = "latest";
      if (!L.resolutions.includes(S.caps.resolution)) S.caps.resolution = L.resolutions.includes("1920x1080") ? "1920x1080" : L.resolutions[0];
    } catch {
      S.capsLists = { browsers: ["Chrome", "MicrosoftEdge", "Firefox", "Safari"], versions: ["latest", "latest-1", "latest-2"], platforms: ["Windows 11", "Windows 10", "macOS Sonoma", "Linux"], resolutions: ["1920x1080"], live: false };
    }
  }
  const r = core.generateConnection(S.profile, S.caps);
  r.points = core.planConnectionChanges(core.findDriverSetup(ROOT, S.profile), r);
  S.capsResult = r;
  if (S.tab === "grid") renderGrid($("#panel"));
}

// ---------- report a problem (prepared GitHub issue; the visitor reviews it before anything is sent) ----------
function reportProblem() {
  const v = S.validation;
  const masked = (S.yaml || "").replace(/^(\s*LT_(?:USERNAME|ACCESS_KEY):\s*)(?!\$\{\{).+$/gm, "$1<masked>").replace(/^(\s*\w*(?:KEY|TOKEN|SECRET|PASSWORD)\w*:\s*)(?!\$\{\{|<set ).+$/gim, "$1<masked>");
  const body = [
    "**What happened**", "<!-- Describe what you expected and what you got. -->", "",
    "**Setup**",
    `- Studio web v${VERSION}`,
    S.profile ? `- Stack: ${stackLine(S.summary, S.result?.framework)}` : "- No repo loaded",
    S.result ? `- YAML v${S.result.yamlVersion}, options: \`${JSON.stringify(S.options)}\`` : "",
    v?.errors?.length ? `- Checks failing: ${v.errors.slice(0, 5).join(" | ")}` : "",
    "",
    S.yaml ? "<details><summary>YAML (credentials masked — review before submitting)</summary>\n\n```yaml\n" + masked.slice(0, 5000) + "\n```\n</details>" : "",
  ].filter((l) => l !== "").join("\n");
  const url = `${REPORT_URL}?title=${encodeURIComponent(`[web] ${S.result ? fwName(S.result.framework) + ": " : ""}`)}&body=${encodeURIComponent(body).slice(0, 7000)}`;
  window.open(url, "_blank", "noopener");
  toast("Opened a prepared GitHub issue — nothing is sent until you submit it");
}

// ---------- share a setup (options only, never code) ----------
function shareLink() {
  const setup = { v: 1, name: S.repoName, repo: S.source || null, options: S.options };
  const b64 = btoa(unescape(encodeURIComponent(JSON.stringify(setup)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${location.origin}${location.pathname}#setup=${b64}`;
}
function readSharedSetup() {
  const m = location.hash.match(/#setup=([\w-]+)/);
  if (!m) return null;
  try { return JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))))); } catch { return null; }
}
function applyPendingSetup() {
  const p = S.pendingSetup;
  if (!p) return;
  S.pendingSetup = null;
  history.replaceState(null, "", location.pathname);
  const r = applyOptions(p.options || {});
  renderAll();
  say("bot", r.error ? `The shared setup doesn't fit this repo: ${r.error}` : `Applied the shared setup${p.name ? ` for **${p.name}**` : ""}. ${checkLine()}`, { chips: [{ label: "Undo", send: "undo", icon: "undo" }] });
}

// ---------- usual settings, remembered in this browser per framework ----------
const USUAL = ["runson", "concurrency", "splitBy", "retryOnFailure", "maxRetries", "globalTimeout", "tunnel"]; // same as src/learning.js
function saveUsual() {
  if (!S.result) return;
  const o = Object.fromEntries(Object.entries(S.options).filter(([k]) => USUAL.includes(k)));
  try { if (Object.keys(o).length) localStorage.setItem(`he-usual:${S.result.framework}`, JSON.stringify(o)); } catch {}
}
function loadUsual(framework) {
  try { return JSON.parse(localStorage.getItem(`he-usual:${framework}`) || "null"); } catch { return null; }
}
const describeOptions = (o) => [o.runson && (OS_NAME[o.runson] || o.runson), o.concurrency && plural(o.concurrency, "VM"), o.splitBy && `split by ${o.splitBy}`, o.tunnel && "tunnel", o.maxRetries && plural(o.maxRetries, "retry"), o.globalTimeout && `${o.globalTimeout} min`].filter(Boolean).join(" · ");

// ---------- import a public GitHub repo (read straight from GitHub into this tab) ----------
function parseGithub(input) {
  const m = String(input).trim().match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([^?#]+))?\/?(?:[?#].*)?$/) || String(input).trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], repo: m[2], ref: m[3] || null } : null;
}
async function fromGithub(input) {
  const g = parseGithub(input);
  if (!g) throw new Error("Paste a GitHub repo URL, like https://github.com/owner/repo");
  progress(`Looking up ${g.owner}/${g.repo}…`);
  const api = (p) => fetch(`https://api.github.com/repos/${g.owner}/${g.repo}${p}`, { headers: { Accept: "application/vnd.github+json" } });
  let ref = g.ref;
  if (!ref) {
    const r = await api("");
    if (r.status === 404) throw new Error("Repo not found, or it's private. Private repos: download them as .zip and upload that.");
    if (r.status === 403) throw new Error("GitHub's hourly limit for anonymous requests was reached. Try again later, or upload a .zip.");
    ref = (await r.json()).default_branch;
  }
  const t = await api(`/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  if (!t.ok) throw new Error(t.status === 403 ? "GitHub's hourly limit for anonymous requests was reached. Try again later, or upload a .zip." : `Couldn't read the repo's files (GitHub ${t.status}).`);
  const tree = await t.json();
  const blobs = tree.tree.filter((e) => e.type === "blob" && !skipPath(e.path));
  const wanted = blobs.filter((b) => b.size <= MAX_TEXT && !BINARY.test(b.path)).slice(0, 2500);
  const texts = new Map();
  let done = 0;
  const queue = [...wanted];
  const worker = async () => {
    for (let b; (b = queue.shift()); ) {
      const r = await fetch(`https://raw.githubusercontent.com/${g.owner}/${g.repo}/${encodeURIComponent(ref)}/${b.path.split("/").map(encodeURIComponent).join("/")}`);
      if (r.ok) texts.set(b.path, await r.text());
      if (++done % 25 === 0) progress(`Reading ${done} of ${wanted.length} files from GitHub…`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  S.source = `https://github.com/${g.owner}/${g.repo}${g.ref ? `/tree/${g.ref}` : ""}`;
  await ingest(g.repo, blobs.map((b) => ({ rel: b.path, size: b.size, read: async () => texts.get(b.path) || "" })));
}

// ---------- settings: LambdaTest account + optional Claude ----------
function openSettings() {
  const d = $("#settings");
  const l = S.lt, a = S.ai;
  d.innerHTML = `
    <div class="dlg-h">Settings<span class="spacer"></span><button class="btn quiet icon" id="dlgClose" aria-label="Close">${icon.x}</button></div>
    <div class="dlg-b">
      <section>
        <h3>LambdaTest account <span class="faint small">(optional)</span></h3>
        <p>Put your username and access key straight into the YAML. Kept in this tab only, never stored, and sent only to LambdaTest when you click Check.</p>
        <div class="stack">
          <label class="fld">Username<input type="text" id="ltUser" autocomplete="off" spellcheck="false" value="${esc(l.user)}"></label>
          <label class="fld">Access key<input type="password" id="ltKey" autocomplete="off" value="${esc(l.key)}"></label>
          <label class="switch"><input type="checkbox" id="ltEmbed" ${l.embed ? "checked" : ""}><span class="track"></span>Use them in the YAML</label>
          <div class="row"><button class="btn sm" id="ltCheck">Check with LambdaTest</button><span class="state ${l.state?.ok ? "ok" : "err"}" id="ltState">${esc(l.state?.text || "")}</span></div>
        </div>
      </section>
      <section>
        <h3>Claude for free-form questions <span class="faint small">(optional)</span></h3>
        <p>The built-in assistant handles setup changes, checks and diagnosis without any AI. Add your own Anthropic API key to also ask anything in plain words. Sent to Anthropic: your question, the YAML and a summary of the repo, never your source files. The key is kept in this tab only.</p>
        <div class="stack">
          <label class="fld">Anthropic API key<input type="password" id="aiKey" autocomplete="off" placeholder="sk-ant-…" value="${esc(a.key)}"></label>
          <label class="switch"><input type="checkbox" id="aiOn" ${a.on ? "checked" : ""}><span class="track"></span>Use Claude in the chat</label>
          <div class="row"><button class="btn sm" id="aiCheck">Check key</button><span class="state ${a.state?.ok ? "ok" : "err"}" id="aiState">${esc(a.state?.text || "")}</span></div>
        </div>
      </section>
    </div>`;
  const refresh = () => { if (S.profile && !S.dirty) { regenerate(); renderAll(); } };
  $("#dlgClose").onclick = () => d.close();
  let t;
  $("#ltUser").oninput = (e) => { S.lt.user = e.target.value; S.lt.state = null; clearTimeout(t); t = setTimeout(refresh, 400); };
  $("#ltKey").oninput = (e) => { S.lt.key = e.target.value; S.lt.state = null; clearTimeout(t); t = setTimeout(refresh, 400); };
  $("#ltEmbed").onchange = (e) => { S.lt.embed = e.target.checked; refresh(); };
  $("#ltCheck").onclick = async () => {
    const u = S.lt.user.trim(), k = S.lt.key.trim();
    if (!u || !k) return ($("#ltState").textContent = "Enter both first");
    $("#ltState").textContent = "Checking…";
    try {
      const res = await fetch("https://api.lambdatest.com/automation/api/v1/builds?limit=1", { headers: { Authorization: "Basic " + btoa(unescape(encodeURIComponent(`${u}:${k}`))) }, signal: AbortSignal.timeout(15000) });
      S.lt.state = res.status === 200 ? { ok: true, text: `Connected as ${u}` } : res.status === 401 ? { ok: false, text: "Invalid username or key" } : { ok: false, text: `LambdaTest returned ${res.status}` };
    } catch { S.lt.state = { ok: false, text: "Couldn't reach LambdaTest" }; }
    $("#ltState").textContent = S.lt.state.text;
    $("#ltState").className = `state ${S.lt.state.ok ? "ok" : "err"}`;
  };
  $("#aiKey").oninput = (e) => { S.ai.key = e.target.value.trim(); S.ai.state = null; if (S.ai.key && !S.ai.on) { S.ai.on = true; $("#aiOn").checked = true; } renderChat(); };
  $("#aiOn").onchange = (e) => { S.ai.on = e.target.checked && !!S.ai.key; e.target.checked = S.ai.on; if (e.target.checked !== S.ai.on || (!S.ai.key && e.target.checked)) toast("Add an API key first"); renderChat(); };
  $("#aiCheck").onclick = async () => {
    if (!S.ai.key) return ($("#aiState").textContent = "Enter a key first");
    $("#aiState").textContent = "Checking…";
    try { const { checkKey } = await import("./claude.js"); await checkKey(S.ai.key); S.ai.state = { ok: true, text: "Key works" }; }
    catch (e) { S.ai.state = { ok: false, text: e?.status === 401 ? "Key rejected" : "Couldn't reach Anthropic" }; }
    $("#aiState").textContent = S.ai.state.text;
    $("#aiState").className = `state ${S.ai.state.ok ? "ok" : "err"}`;
  };
  d.showModal();
}

S.pendingSetup = readSharedSetup();
landing();
if (S.pendingSetup?.repo && parseGithub(S.pendingSetup.repo)) fromGithub(S.pendingSetup.repo).catch(fail);
