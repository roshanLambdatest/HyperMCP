// HyperExecute Studio — VS Code extension host side.
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { pathToFileURL } = require("url");
const { execFile } = require("child_process");
const ai = require("./ai");

let core;
async function loadCore() {
  if (!core) {
    // Protected builds ship one bundled core.mjs; development uses the synced core/ files.
    const bundled = path.join(__dirname, "core.mjs");
    if (fs.existsSync(bundled)) return (core = { ...(await import(pathToFileURL(bundled).href)) });
    const imp = (f) => import(pathToFileURL(path.join(__dirname, "core", f)).href);
    const mods = await Promise.all(["analyzer.js", "generator.js", "validator.js", "knowledge.js", "confluence.js", "security.js", "capabilities.js", "optimizer.js", "runner.js", "doctor.js", "credentials.js", "feedback.js", "discovery-check.js", "assistant.js", "names.js", "pipelines.js", "learning.js", "report.js", "gists.js", "docs.js", "changes.js", "yaml-explain.js", "yaml-problems.js"].map(imp));
    core = Object.assign({}, ...mods);
  }
  return core;
}

// Confluence module reads credentials from env at call time.
async function applyAtlassianEnv(context) {
  const cfg = vscode.workspace.getConfiguration("hyperexecute");
  const token = await context.secrets.get("hyperexecute.atlassianToken");
  const set = (k, v) => (v ? (process.env[k] = v) : delete process.env[k]);
  set("ATLASSIAN_EMAIL", cfg.get("atlassianEmail"));
  set("ATLASSIAN_API_TOKEN", token);
  set("CONFLUENCE_BASE_URL", cfg.get("confluenceBaseUrl"));
  set("CONFLUENCE_SPACE", cfg.get("confluenceSpace"));
  process.env.HE_GISTS = cfg.get("gistSources") || "off"; // empty setting = off; the default is the shared pool
  return { email: cfg.get("atlassianEmail"), token };
}

function activate(context) {
  const studio = new Studio(context);
  Studio.current = studio;
  setTimeout(() => syncGistKnowledge(context, false), 5000); // background, after startup
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("hyperexecute.gistSources") && syncGistKnowledge(context, false)));
  // opens the Studio; with a pane name, on that tab (the status bar uses this)
  const open = async (pane) => {
    await vscode.commands.executeCommand("workbench.view.extension.hyperexecute");
    await vscode.commands.executeCommand("hyperexecute.studio.focus");
    if (typeof pane === "string") studio.post({ type: "showPane", pane });
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("hyperexecute.openStudio", open),
    vscode.commands.registerCommand("hyperexecute.setAtlassianToken", () => setAtlassian(context)),
    vscode.commands.registerCommand("hyperexecute.addToConfluence", () => studio.publishConfluence()),
    vscode.commands.registerCommand("hyperexecute.syncGists", () => syncGistKnowledge(context, true)),
    vscode.commands.registerCommand("hyperexecute.checkForUpdates", () => checkForUpdate(context, true)),
    vscode.commands.registerCommand("hyperexecute.setAnthropicKey", () => setAnthropicKey(context)),
    vscode.commands.registerCommand("hyperexecute.chooseBackend", () => chooseBackend(context)),
    vscode.commands.registerCommand("hyperexecute.validateActiveFile", () => validateActive()),
    vscode.commands.registerCommand("hyperexecute.annotateActiveFile", async (uri) => {
      const doc = uri instanceof vscode.Uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
      if (!doc) return vscode.window.showInformationMessage("Open a HyperExecute YAML first.");
      return openAnnotated(doc.getText(), path.basename(doc.fileName));
    }),
    vscode.commands.registerCommand("hyperexecute.runFile", (uri) => studio.runFile(uri)),
    // hover over a line of a hyperexecute*.yaml file: what it does on HyperExecute
    vscode.languages.registerHoverProvider({ language: "yaml", pattern: "**/*hyperexecute*.{yml,yaml}" }, {
      async provideHover(doc, pos) {
        const c = await loadCore();
        const l = c.explainYamlLines(doc.getText()).find((x) => x.n === pos.line + 1);
        if (!l?.what || l.kind === "blank" || l.kind === "continued") return null;
        return new vscode.Hover(new vscode.MarkdownString(`**HyperExecute**${l.path ? ` · \`${l.path}\`` : ""}\n\n${l.what}`));
      },
    }),
    vscode.window.registerWebviewViewProvider(
      "hyperexecute.studio",
      {
        resolveWebviewView(view) {
          view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, "media"))] };
          studio.attach(view.webview);
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => studio.refreshRepos())
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = "$(rocket) HyperExecute";
  status.tooltip = "Open HyperExecute Studio";
  status.command = "hyperexecute.openStudio";
  status.show();
  context.subscriptions.push(status);
  statusItem = status;
  registerYamlTools(context);

  registerMcpServer(context);
  watchForNewerVersion(context, status);
  watchForUpdates(context);
}

// ---------- "Reload to update" ----------
// A running window keeps the version it loaded until it reloads. When a newer copy of this extension
// is installed (Extensions view, `code --install-extension`, or a .vsix), offer the reload.

const cmpVersion = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

function newestInstalledVersion(context) {
  const { publisher, name } = context.extension.packageJSON;
  const prefix = `${publisher}.${name}-`.toLowerCase();
  const dir = path.dirname(context.extensionPath);
  // extensions.json is VS Code's registry of what's installed; fall back to folder names.
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(dir, "extensions.json"), "utf8"));
    const entry = reg.find((e) => e.identifier?.id?.toLowerCase() === `${publisher}.${name}`.toLowerCase());
    if (entry?.version) return entry.version;
  } catch {}
  let best = null;
  try {
    for (const d of fs.readdirSync(dir)) {
      if (!d.toLowerCase().startsWith(prefix)) continue;
      const v = d.slice(prefix.length).match(/^\d+\.\d+\.\d+/)?.[0];
      if (v && (!best || cmpVersion(v, best) > 0)) best = v;
    }
  } catch {}
  return best;
}

function watchForNewerVersion(context, status) {
  if (!context.extension?.packageJSON?.version) return;
  const running = context.extension.packageJSON.version;
  let offered = null;
  const check = () => {
    const newest = newestInstalledVersion(context);
    if (!newest || cmpVersion(newest, running) <= 0 || offered === newest) return;
    offered = newest;
    status.text = "$(sync) HyperExecute: reload to update";
    status.tooltip = `HyperExecute Studio ${newest} is installed — this window is still running ${running}.`;
    status.command = "workbench.action.reloadWindow";
    status.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    vscode.window
      .showInformationMessage(`HyperExecute Studio ${newest} is installed. Reload the window to use it (currently running ${running}).`, "Reload Window", "Later")
      .then((pick) => pick === "Reload Window" && vscode.commands.executeCommand("workbench.action.reloadWindow"));
    Studio.current?.post({ type: "updateReady", version: newest, running });
  };
  let timer;
  const soon = () => { clearTimeout(timer); timer = setTimeout(check, 1500); };
  check();
  context.subscriptions.push(
    vscode.extensions.onDidChange(soon),
    vscode.window.onDidChangeWindowState((s) => s.focused && soon()),
    { dispose: () => clearTimeout(timer) }
  );
  try {
    const w = fs.watch(path.dirname(context.extensionPath), soon); // new version folder appears
    context.subscriptions.push({ dispose: () => w.close() });
  } catch {}
}

// ---------- Updates from GitHub releases ----------
// The extension isn't on the Marketplace, so it updates itself: it looks at the latest GitHub release of this
// repo every 15 minutes and whenever a VS Code window gets focus (at most every 5 minutes), and
// (hyperexecute.autoUpdate) offers or installs a newer .vsix as soon as one is published. The download is
// checked against the release's SHA-256 before it is installed; the "Reload to update" watcher above then
// offers the reload. Checks are conditional requests (ETag): an unchanged release answers 304, which
// doesn't count against GitHub's hourly limit for unauthenticated calls. All windows share the throttle, and
// a version is offered once a day at most (globalState), so frequent checks never mean frequent prompts.

const RELEASES = "https://api.github.com/repos/roshanLambdatest/HyperMCP/releases/latest";
const ASSET = "hyperexecute-studio.vsix";
const DAY = 24 * 3600 * 1000;
const CHECK_EVERY = 15 * 60 * 1000;
const MIN_GAP = 5 * 60 * 1000;

async function latestRelease(context) {
  const cached = context.globalState.get("hyperexecute.latestRelease");
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "hyperexecute-studio" };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  const res = await fetch(RELEASES, { headers, signal: AbortSignal.timeout(15000) });
  if (res.status === 304 && cached?.release) return cached.release;
  if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? "GitHub's hourly limit was reached; try again later" : `GitHub ${res.status}`);
  const r = await res.json();
  const asset = (r.assets || []).find((a) => a.name === ASSET);
  const release = { version: String(r.tag_name || "").replace(/^v/, ""), url: asset?.browser_download_url, sha256: /^sha256:[0-9a-f]{64}$/.test(asset?.digest || "") ? asset.digest.slice(7) : null, notes: r.html_url };
  await context.globalState.update("hyperexecute.latestRelease", { etag: res.headers.get("etag") || null, release });
  return release;
}

async function downloadVsix(rel) {
  const u = new URL(rel.url);
  if (u.protocol !== "https:" || u.hostname !== "github.com" || !u.pathname.startsWith("/roshanLambdatest/HyperMCP/releases/download/")) throw new Error(`Unexpected download location ${u.hostname}`);
  const res = await fetch(rel.url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000 || buf.subarray(0, 2).toString() !== "PK") throw new Error("The download isn't a .vsix package");
  const sum = require("crypto").createHash("sha256").update(buf).digest("hex");
  if (!rel.sha256) throw new Error("The release has no SHA-256 to check the download against; install it by hand");
  if (sum !== rel.sha256) throw new Error("The download doesn't match the release's SHA-256; not installing it");
  const file = path.join(require("os").tmpdir(), `hyperexecute-studio-${rel.version}.vsix`);
  fs.writeFileSync(file, buf);
  return file;
}

async function checkForUpdate(context, manual) {
  const mode = vscode.workspace.getConfiguration("hyperexecute").get("autoUpdate") || "notify";
  if (!manual && mode === "off") return;
  const running = context.extension?.packageJSON?.version;
  if (!running) return;
  // automatic checks: at most one every few minutes across all windows
  if (!manual && Date.now() - (context.globalState.get("hyperexecute.updateCheckedAt") || 0) < MIN_GAP) return;
  await context.globalState.update("hyperexecute.updateCheckedAt", Date.now());
  let rel;
  try {
    rel = await latestRelease(context);
  } catch (e) {
    if (manual) vscode.window.showErrorMessage(`Couldn't check for updates: ${e.message}`);
    return;
  }
  const installed = newestInstalledVersion(context) || running;
  if (!rel.url || !/^\d+\.\d+\.\d+$/.test(rel.version) || cmpVersion(rel.version, installed) <= 0) {
    if (manual) vscode.window.showInformationMessage(`HyperExecute Studio is up to date (${installed}).`);
    return;
  }
  if (!manual && context.globalState.get("hyperexecute.skipVersion") === rel.version) return;
  // checks run often; the question for one version comes back at most once a day
  const offered = context.globalState.get("hyperexecute.offered") || {};
  if (!manual && offered.version === rel.version && Date.now() - offered.at < DAY) return;
  if (mode !== "install" || manual) {
    await context.globalState.update("hyperexecute.offered", { version: rel.version, at: Date.now() });
    const pick = await vscode.window.showInformationMessage(`HyperExecute Studio ${rel.version} is available (you have ${running}).`, "Update", "What's new", ...(manual ? [] : ["Skip this version"]));
    if (pick === "What's new") return vscode.env.openExternal(vscode.Uri.parse(rel.notes));
    if (pick === "Skip this version") return context.globalState.update("hyperexecute.skipVersion", rel.version);
    if (pick !== "Update") return;
  }
  try {
    const file = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Updating HyperExecute Studio to ${rel.version}…` }, async () => {
      const f = await downloadVsix(rel);
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(f));
      return f;
    });
    fs.rm(file, { force: true }, () => {});
  } catch (e) {
    vscode.window.showErrorMessage(`Couldn't update HyperExecute Studio: ${e.message}`, "Open release").then((a) => a && vscode.env.openExternal(vscode.Uri.parse(rel.notes)));
  }
}

function watchForUpdates(context) {
  const t = setTimeout(() => checkForUpdate(context, false), 20000); // after startup settles
  const i = setInterval(() => checkForUpdate(context, false), CHECK_EVERY);
  // coming back to VS Code is when a new release matters: check then too (the throttle still applies)
  const f = vscode.window.onDidChangeWindowState((s) => s.focused && checkForUpdate(context, false));
  context.subscriptions.push(f, { dispose: () => { clearTimeout(t); clearInterval(i); } });
}

// Expose the bundled MCP server to VS Code agent mode (Copilot etc.).
function registerMcpServer(context) {
  if (!vscode.lm?.registerMcpServerDefinitionProvider || !vscode.McpStdioServerDefinition) return;
  const emitter = new vscode.EventEmitter();
  context.subscriptions.push(
    vscode.lm.registerMcpServerDefinitionProvider("hyperexecute.mcp", {
      onDidChangeMcpServerDefinitions: emitter.event,
      provideMcpServerDefinitions: async () => {
        const { email, token } = await applyAtlassianEnv(context);
        const cfg = vscode.workspace.getConfiguration("hyperexecute");
        const env = {
          ELECTRON_RUN_AS_NODE: "1",
          HE_DEFAULT_REPO: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "",
          CONFLUENCE_BASE_URL: cfg.get("confluenceBaseUrl") || "",
          CONFLUENCE_SPACE: cfg.get("confluenceSpace") || "",
        };
        if (email && token) Object.assign(env, { ATLASSIAN_EMAIL: email, ATLASSIAN_API_TOKEN: token });
        return [new vscode.McpStdioServerDefinition("HyperExecute Studio", process.execPath, [fs.existsSync(path.join(__dirname, "mcp.mjs")) ? path.join(__dirname, "mcp.mjs") : path.join(__dirname, "core", "index.js")], env, "1.0.0")];
      },
    }),
    context.secrets.onDidChange(() => emitter.fire()),
    vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration("hyperexecute") && emitter.fire())
  );
}

// Gists as knowledge (hyperexecute.gistSources): refreshed in the background, at most every 6 hours unless asked.
async function syncGistKnowledge(context, manual) {
  await applyAtlassianEnv(context);
  if (/^off$/i.test(process.env.HE_GISTS)) {
    if (manual) vscode.window.showInformationMessage("Gist knowledge is off. Set hyperexecute.gistSources to a GitHub user or gist links.", "Open settings").then((a) => a && vscode.commands.executeCommand("workbench.action.openSettings", "hyperexecute.gistSources"));
    return;
  }
  try {
    const c = await loadCore();
    const r = await c.syncGists({ force: !!manual });
    if (manual) vscode.window.showInformationMessage(`Gist knowledge updated: ${r.gists ?? 0} gists, ${r.files ?? 0} files${r.skipped?.length ? `, ${r.skipped.length} skipped (credentials or not text)` : ""}.`);
  } catch (e) {
    if (manual) vscode.window.showErrorMessage(`Couldn't update gist knowledge: ${e.message}`);
  }
}

async function setAtlassian(context) {
  const cfg = vscode.workspace.getConfiguration("hyperexecute");
  const email = await vscode.window.showInputBox({ prompt: "Atlassian account email", value: cfg.get("atlassianEmail") || "", ignoreFocusOut: true });
  if (email === undefined) return;
  const token = await vscode.window.showInputBox({ prompt: "Atlassian / Jira API token (stored in VS Code's encrypted secret storage)", password: true, ignoreFocusOut: true });
  if (!token) return;
  await cfg.update("atlassianEmail", email, vscode.ConfigurationTarget.Global);
  await context.secrets.store("hyperexecute.atlassianToken", token.trim());
  await applyAtlassianEnv(context);
  try {
    const c = await loadCore();
    const me = await c.whoAmI();
    vscode.window.showInformationMessage(`Confluence connected as ${me.displayName}.`);
  } catch (e) {
    vscode.window.showErrorMessage(`Confluence check failed: ${e.message}`);
  }
  Studio.current?.refreshMeta();
}

async function setAnthropicKey(context) {
  const key = await vscode.window.showInputBox({ prompt: "Anthropic API key (stored in VS Code's encrypted secret storage)", password: true, ignoreFocusOut: true });
  if (!key) return;
  await context.secrets.store("hyperexecute.anthropicKey", key.trim());
  vscode.window.showInformationMessage("Anthropic API key saved.");
  Studio.current?.refreshMeta();
}

async function chooseBackend(context) {
  const b = await ai.detectBackend(context);
  const items = ["auto", "claude-cli", "vscode-lm", "anthropic-api", "rules"].map((k) => ({
    label: k === "auto" ? "Auto" : ai.LABELS[k],
    id: k,
    description: k === "auto" ? `currently: ${ai.LABELS[b.name]}` : b.available[k] ? "available" : "not configured",
  }));
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "AI backend for the HyperExecute Studio chat" });
  if (!pick) return;
  await vscode.workspace.getConfiguration("hyperexecute").update("aiBackend", pick.id, vscode.ConfigurationTarget.Global);
  if (pick.id === "anthropic-api" && !b.apiKey) await setAnthropicKey(context);
  Studio.current?.refreshMeta();
}

async function validateActive() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return;
  const c = await loadCore();
  const folder = vscode.workspace.getWorkspaceFolder(ed.document.uri)?.uri.fsPath;
  const r = c.validateYaml(ed.document.getText(), folder);
  const msg = r.valid ? `HyperExecute YAML valid${r.warnings.length ? ` (${r.warnings.length} warnings)` : ""}` : `HyperExecute YAML: ${r.errors.length} error(s) — ${r.errors[0]}`;
  (r.valid ? vscode.window.showInformationMessage : vscode.window.showErrorMessage)(msg, "Open Studio").then((a) => a && vscode.commands.executeCommand("hyperexecute.openStudio"));
}

// ---------- the Studio (docked side-bar webview view) ----------

class Studio {
  static current;

  constructor(context) {
    this.context = context;
    this.webview = null;
    this.state = { repos: [], repo: null, profile: null, options: {}, result: null, yaml: "", dirty: false, validation: null, chat: [], meta: {} };
    this.cts = null;
  }

  // Called each time VS Code (re)creates the view; state lives here so it survives.
  attach(webview) {
    this.webview = webview;
    webview.html = this.html();
    webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.toast(e.message, "error")));
  }

  refreshRepos() {
    this.state.repos = (vscode.workspace.workspaceFolders || []).map((f) => ({ name: f.name, path: f.uri.fsPath }));
    if (!this.state.repo && this.state.repos[0]) return this.analyze(this.state.repos[0].path);
    this.push();
  }

  post(msg) {
    this.webview?.postMessage(msg);
  }
  push() {
    this.state.explain = this.explainLines();
    this.state.onDisk = this.diskState();
    updateStatus(this.state);
    this.post({ type: "state", state: this.state });
  }
  // is the YAML in the Studio the one saved in the repo? "same" | "different" | "none"
  diskState() {
    if (!this.state.repo || !this.state.yaml) return "none";
    try { return fs.readFileSync(path.join(this.state.repo, this.outputName()), "utf8") === this.state.yaml ? "same" : "different"; } catch { return "none"; }
  }
  // the current YAML explained line by line, for the Explain tab
  explainLines() {
    try { return core?.explainYamlLines ? core.explainYamlLines(this.state.yaml || "") : []; } catch { return []; }
  }
  busy(label) {
    this.post({ type: "busy", label: label || null });
  }
  toast(text, kind = "info") {
    this.post({ type: "toast", text, kind });
  }

  async refreshMeta() {
    const b = await ai.detectBackend(this.context);
    const { email, token } = await applyAtlassianEnv(this.context);
    const acct = await this.ltAccount();
    this.ltCreds = acct.username && acct.accessKey ? acct : null;
    const embedCreds = this.context.globalState.get("hyperexecute.embedCredentials") !== false;
    this.state.meta = { ltUser: acct.username || null, ltReady: !!(acct.username && acct.accessKey), embedCreds, backend: ai.LABELS[b.name], backendId: b.name, confluence: !!(email && token), confluenceSpace: vscode.workspace.getConfiguration("hyperexecute").get("confluenceSpace") || "HYP" };
    this.push();
  }

  optionsKey() {
    return `hyperexecute.options:${this.state.repo}`;
  }

  async onMessage(m) {
    const c = await loadCore();
    switch (m.type) {
      case "ready": {
        await this.refreshMeta();
        if (this.state.repo) this.push();
        else this.refreshRepos();
        break;
      }
      case "selectRepo":
        await this.analyze(m.path);
        break;
      case "browseRepo": {
        const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: "Use this repo" });
        if (pick?.[0]) {
          const p = pick[0].fsPath;
          if (!this.state.repos.some((r) => r.path === p)) this.state.repos.push({ name: path.basename(p), path: p });
          await this.analyze(p);
        }
        break;
      }
      case "reanalyze":
        await this.analyze(this.state.repo);
        break;
      case "setOptions":
        if (this.state.dirty) {
          const ok = await vscode.window.showWarningMessage("Regenerating will discard your manual YAML edits.", { modal: true }, "Regenerate");
          if (ok !== "Regenerate") return this.push();
        }
        this.state.options = clean({ ...this.state.options, ...m.options });
        this.regenerate();
        break;
      case "resetOptions":
        this.state.options = {};
        this.regenerate();
        break;
      case "yamlEdited":
        this.state.yaml = m.yaml;
        this.state.dirty = true;
        this.state.validation = strip(c.validateYaml(m.yaml, this.state.repo));
        this.post({ type: "validation", validation: this.state.validation, dirty: true, explain: this.explainLines() });
        updateStatus(this.state);
        break;
      case "chat":
        await this.chat(m.text);
        break;
      case "cancel":
        this.cts?.cancel();
        break;
      case "dryRun":
        await this.dryRun();
        break;
      case "save":
        await this.save(false);
        break;
      case "openInEditor":
        await this.save(true);
        break;
      case "copy":
        await vscode.env.clipboard.writeText(this.state.yaml);
        this.toast("YAML copied to clipboard");
        break;
      case "run":
        await this.run({ auto: m.auto, maxAttempts: m.maxAttempts });
        break;
      case "runStop":
        this.stopRun();
        break;
      case "runApplyFixes":
        await this.applyRunFixes(m.ids || null, m.rerun !== false, m.values || {});
        break;
      case "runRerun":
        if (!this.runHandle && this.state.run) { this.state.run.maxAttempts = Math.max(this.state.run.maxAttempts, this.state.run.attempt + 1); await this.startAttempt(m.onlyFailed && this.lastDiagnosis?.tests?.list?.length ? this.buildFailedOnlyRerun() : undefined); }
        break;
      case "runAskAI":
        await this.askAiForRunFix();
        break;
      case "runApplyAI":
        await this.applyAiRunFix(m.rerun !== false);
        break;
      case "runSetAuto":
        if (this.state.run) { this.state.run.auto = !!m.auto; this.state.run.maxAttempts = Math.min(10, Math.max(1, +m.maxAttempts || this.state.run.maxAttempts)); }
        break;
      case "runOpenLog":
        this.output().show(true);
        break;
      case "openLink":
        if (/^https:\/\//.test(m.url)) vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      case "command":
        if (m.id?.startsWith("hyperexecute.") || m.id === "workbench.action.files.openFolder") await vscode.commands.executeCommand(m.id);
        break;
      case "ltAccountSave": {
        const username = String(m.username || "").trim();
        const accessKey = String(m.accessKey || "").trim();
        if (!username || !accessKey) return this.toast("Enter both username and access key", "error");
        const t = await this.testLtAccount(username, accessKey);
        if (!t.ok) return this.post({ type: "ltStatus", ok: false, text: t.text });
        await this.context.globalState.update("hyperexecute.ltUsername", username);
        await this.context.secrets.store("hyperexecute.ltAccessKey", accessKey);
        c.saveCreds({ username, accessKey }); // shared with the MCP server (Claude Code / Copilot)
        this.post({ type: "ltStatus", ok: true, text: t.text + " — saved for the Studio, the MCP tools and new YAMLs" });
        await this.credsChanged();
        break;
      }
      case "ltAccountTest": {
        const a = await this.ltAccount();
        if (!a.username) return this.post({ type: "ltStatus", ok: false, text: "No account saved" });
        this.post({ type: "ltStatus", ...(await this.testLtAccount(a.username, a.accessKey)) });
        break;
      }
      case "ltAccountClear":
        await this.context.globalState.update("hyperexecute.ltUsername", undefined);
        await this.context.secrets.delete("hyperexecute.ltAccessKey");
        c.clearCreds();
        this.post({ type: "ltStatus", ok: false, text: "Removed" });
        await this.credsChanged();
        break;
      case "setEmbedCreds":
        await this.context.globalState.update("hyperexecute.embedCredentials", !!m.on);
        await this.credsChanged();
        break;
      case "rescan":
        this.state.scan = c.scanRepo(this.state.repo);
        this.push();
        break;
      case "fixCredentials":
        await this.fixCredentials();
        break;
      case "openFile":
        await this.openFile(m.file, m.line);
        break;
      case "capsOptions":
        this.post({ type: "capsOptions", result: await c.capabilityOptions(m.opts || {}) });
        break;
      case "capsGenerate":
        await this.capabilities(m.opts || {});
        break;
      case "copyText":
        await vscode.env.clipboard.writeText(String(m.text || ""));
        this.toast("Copied");
        break;
      case "optimize":
        await this.optimize();
        break;
      case "applyOptimizations":
        if (this.state.dirty && !(await vscode.window.showWarningMessage("Apply optimizations on top of your edited YAML?", { modal: true }, "Apply"))) return;
        await this.applyOptimizations(m.ids);
        break;
      case "reloadWindow":
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
        break;
      case "publishConfluence":
        await this.publishConfluence();
        break;
      case "openAnnotated":
        await openAnnotated(this.state.yaml, this.outputName());
        break;
      case "undoChat":
        this.undo(m.id);
        break;
      case "clearChat":
        this.state.chat = [];
        this.snapshots?.clear();
        this.push();
        break;
    }
  }

  // What was done per repo in this window, for "Add to Confluence". It also goes into the chat as a
  // timeline line (unless ui.chat is false), so the chat tells the whole story of the setup.
  // ui: { chat, tone: "ok" | "warn" | "bad", pane: tab the line opens, url: link it opens }
  logStep(step, detail, ui = {}) {
    if (!this.state.repo) return;
    this.journals ||= new Map();
    const at = Date.now();
    const list = this.journals.get(this.state.repo) || [];
    list.push({ at, step, detail: detail ? String(detail).slice(0, 300) : undefined });
    this.journals.set(this.state.repo, list.slice(-100));
    if (ui.chat === false) return;
    this.state.chat.push({ role: "event", text: step, detail: detail ? String(detail).slice(0, 300) : "", at, tone: ui.tone || "", pane: ui.pane || "", url: ui.url || "" });
  }

  // The YAML state a chat turn starts from, so the turn can be shown as a change and undone.
  snapshot() {
    const { options, yaml, result, dirty, validation, repo } = this.state;
    return { options, yaml, result, dirty, validation, repo };
  }

  restore(s) {
    const { repo, ...rest } = s;
    Object.assign(this.state, rest, { error: null });
  }

  // ▶ Run from the CodeLens of the repo's hyperexecute.yaml: load that file into the Studio and run it.
  async runFile(uri) {
    const folder = uri && vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath;
    if (!folder) return;
    await vscode.commands.executeCommand("hyperexecute.openStudio");
    const doc = await vscode.workspace.openTextDocument(uri);
    if (doc.isDirty) await doc.save();
    if (this.state.repo !== folder) await this.analyze(folder);
    const c = await loadCore();
    const text = doc.getText();
    Object.assign(this.state, { yaml: text, dirty: true, error: null, validation: strip(c.validateYaml(text, folder)) });
    this.push();
    await this.run({});
  }

  // "Explain this YAML line by line": the Explain tab has every line; the chat says how to read it.
  explainInChat() {
    this.post({ type: "showPane", pane: "yaml", tab: "explain" });
    const n = (this.state.explain || this.explainLines()).filter((l) => l.kind === "key" || l.kind === "item").length;
    this.state.chat.push({ role: "assistant", text: `Every line of the YAML is explained in the **Explain** tab under the editor (${n} lines). Click a line there to jump to it in the YAML. **Open annotated copy** opens the YAML with each explanation as a comment above its line, a file you can keep or share. In any hyperexecute*.yaml file in the editor, hover over a line for the same explanation.`, backend: "Studio" });
    this.push();
  }

  // What a chat turn changed: options with why each matters, the YAML diff and the validation after it.
  // The snapshot stays on the extension side; the webview only gets the id it sends back for Undo.
  describeChange(before, explanations = []) {
    this.snapshots ||= new Map();
    const id = (this.turnSeq = (this.turnSeq || 0) + 1);
    this.snapshots.set(id, before);
    let list = core.optionChanges(before.options, this.state.options, explanations);
    // direct YAML edits change no option: show the model's per-key explanations instead
    if (!list.length) list = (explanations || []).filter((e) => e?.key && e?.why).map((e) => ({ key: e.key, why: e.why }));
    return { id, changes: list, diff: core.lineDiff(before.yaml, this.state.yaml), check: core.checkSummary(this.state.validation) };
  }

  // Undo a chat turn (the latest one still applied when no id is given). Later turns were built on
  // top of it, so they are undone with it.
  undo(id) {
    const reply = (text, applied = "") => { this.state.chat.push({ role: "assistant", text, applied, backend: "Studio" }); this.push(); };
    const turns = this.state.chat.filter((m) => m.change && !m.change.undone);
    const target = id ? turns.find((m) => m.change.id === id) : turns[turns.length - 1];
    const before = target && this.snapshots?.get(target.change.id);
    if (!before) return reply("Nothing to undo: no chat change is still applied.");
    if (before.repo !== this.state.repo) return reply("That change was made in another repo, so it can't be undone here.");
    const later = turns.slice(turns.indexOf(target));
    this.restore(before);
    for (const m of later) m.change.undone = true;
    this.context.workspaceState.update(this.optionsKey(), this.state.options);
    this.logStep("Undid a chat change", later.length > 1 ? `${later.length} turns` : target.text.slice(0, 160), { chat: false });
    reply(later.length > 1 ? `Undone: the last ${later.length} changes. The YAML is back to how it was before them.` : "Undone: the YAML is back to how it was before that change.", "YAML restored.");
  }

  async analyze(repoPath) {
    if (!repoPath) return;
    const c = await loadCore();
    this.busy("Analyzing repo…");
    try {
      this.state.repo = repoPath;
      this.state.profileFull = c.analyzeRepo(repoPath);
      this.state.profile = c.summarizeProfile(this.state.profileFull, 25);
      this.state.scan = c.scanRepo(repoPath);
      this.logStep(`Analyzed ${path.basename(repoPath)}`, `${this.state.profileFull.primaryFramework || "no framework"} · ${this.state.scan.credentials.length} hard-coded credential(s)`, { pane: "setup", tone: this.state.scan.credentials.length ? "warn" : "" });
      this.state.discoveredUnits = null;
      // this repo's own saved options win; a repo seen for the first time starts from the user's usual settings
      const saved = this.context.workspaceState.get(this.optionsKey());
      this.state.options = saved || { ...c.learnedOptions(this.state.profileFull), ...(c.readTeamMemory?.(repoPath)?.options || {}) };
      this.state.dirty = false;
      const out = path.join(repoPath, this.outputName());
      this.state.existingFile = fs.existsSync(out) ? this.outputName() : null;
      this.regenerate();
    } finally {
      this.busy();
    }
  }

  outputName() {
    return vscode.workspace.getConfiguration("hyperexecute").get("outputFileName") || "hyperexecute.yaml";
  }

  // Generator options plus the saved LambdaTest account, so new YAMLs carry it (unless turned off in Setup).
  genOptions(extra = {}) {
    const embed = this.state.meta?.embedCreds !== false;
    return { ...this.state.options, ...extra, embedCredentials: embed, ltCredentials: embed && this.ltCreds ? { username: this.ltCreds.username, accessKey: this.ltCreds.accessKey } : undefined };
  }

  // After the account or the toggle changes: rebuild the YAML unless the user has hand edits in it.
  async credsChanged() {
    await this.refreshMeta();
    if (!this.state.profileFull) return;
    if (this.state.dirty) return this.toast("Your hand edits are kept — the account goes into the YAML the next time it is regenerated.");
    this.regenerate();
    this.push();
  }

  regenerate() {
    const c = core;
    try {
      const r = c.generateYaml(this.state.profileFull, this.genOptions({ outputFileName: this.outputName() }));
      this.state.result = { yamlVersion: r.yamlVersion, framework: r.framework, splitBy: r.splitBy, executionMode: r.executionMode, supportedSplits: r.supportedSplits, notes: r.notes, warnings: r.warnings };
      this.state.yaml = r.yaml;
      this.state.dirty = false;
      this.state.error = null;
      this.state.validation = strip(c.validateYaml(r.yaml, this.state.repo));
      this.context.workspaceState.update(this.optionsKey(), this.state.options);
    } catch (e) {
      this.state.error = e.message;
    }
    this.push();
  }

  async chat(text) {
    const c = await loadCore();
    this.state.chat.push({ role: "user", text });
    this.push();
    if (/^(undo|revert|go back)\b/i.test(text.trim())) return this.undo();
    if (/\b(line[- ]by[- ]line|each line|every line|annotat)/i.test(text)) return this.explainInChat();
    // No AI backend: the shared built-in assistant (same as the web version) handles the request.
    if ((await ai.detectBackend(this.context)).name === "rules") return this.builtInChat(c, text);
    this.busy("Thinking…");
    this.cts = new vscode.CancellationTokenSource();
    try {
      // Knowledge: bundled notes + Confluence
      const local = c.searchKnowledge(`${text} ${this.state.result?.framework || ""}`, 3);
      const kb = local.map((d) => ({ source: "bundled", title: `${d.topic} › ${d.section}`, text: d.text.slice(0, 1500) }));
      const sources = [];
      // nothing good locally → the public TestMu AI docs
      if (c.localIsWeak(c.searchKnowledge(text, 1), text)) {
        try {
          for (const d of (await c.searchDocs(text, { limit: 2 })).results.filter((r) => r.text)) {
            kb.push({ source: "testmu-docs", title: d.title, text: d.text });
            sources.push({ title: d.title, url: d.url });
          }
        } catch {}
      }
      if (this.state.meta.confluence) {
        try {
          const hits = await c.searchConfluence(`${this.state.result?.framework || ""} ${text}`.trim(), { limit: 4 });
          const fallback = hits.length ? hits : await c.searchConfluence(this.state.result?.framework || "yaml", { limit: 3 });
          for (const h of fallback.slice(0, 3)) {
            kb.push({ source: "confluence", title: h.title, text: h.excerpt });
            sources.push({ title: h.title, url: h.url });
          }
          if (fallback[0]) {
            const page = await c.getConfluencePage(fallback[0].id, { maxChars: 6000 });
            kb.push({ source: "confluence", title: `${page.title} (full)`, text: page.content });
          }
        } catch (e) {
          kb.push({ source: "confluence", title: "unavailable", text: e.message });
        }
      }
      const context = {
        repo: path.basename(this.state.repo || ""),
        analysis: c.summarizeProfile(this.state.profileFull, 15),
        currentOptions: this.state.options,
        generated: this.state.result,
        currentYaml: this.state.yaml,
        validation: this.state.validation,
        repoScan: this.state.scan ? { summary: this.state.scan.summary, credentials: this.state.scan.credentials.map((f) => `${f.file}:${f.line} ${f.kind}`), reporting: this.state.scan.reporting.map((r) => `${r.name} (${r.file}:${r.line})`) } : null,
        optimizerSuggestions: (() => { try { return c.describeSuggestions(c.optimizeYaml(this.state.yaml, { profile: this.state.profileFull, repoPath: this.state.repo, units: this.state.discoveredUnits }).suggestions); } catch { return []; } })(),
        yamlManuallyEdited: this.state.dirty,
        knowledge: kb,
        // what each turn applied, so "undo that" or "same but for Firefox" make sense to the model
        history: this.state.chat.slice(-12, -1).map((m) => m.role === "event" ? { role: "event", text: `${m.text}${m.detail ? `: ${m.detail}` : ""}` } : { role: m.role, text: m.applied ? `${m.text}\n[${m.applied}${m.change?.changes.length ? `: ${m.change.changes.map((x) => `${x.key} ${x.from} → ${x.to}`).join("; ")}` : ""}${m.change?.undone ? " (undone)" : ""}]` : m.text }),
      };
      const { plan, backend } = await ai.plan(this.context, context, text, this.cts.token);
      let applied = "";
      let change = null;
      if (plan.action === "update_options") {
        const next = { ...this.state.options };
        for (const k of plan.resetOptions || []) delete next[k];
        for (const [k, v] of Object.entries(plan.options || {})) {
          if (v === null || v === undefined) continue;
          if (k === "extraMatrix") next[k] = Object.fromEntries(v.map((a) => [a.key, a.values]));
          else if (k === "extraEnv") next[k] = Object.fromEntries(v.map((a) => [a.name, a.value]));
          else next[k] = v;
        }
        const prev = this.snapshot();
        this.state.options = clean(next);
        this.regenerate();
        let skipped = "";
        // An unsupported split shouldn't throw away the rest of the request.
        if (this.state.error && next.splitBy && /splitBy/.test(this.state.error)) {
          skipped = ` Skipped split "${next.splitBy}": not supported for ${this.state.result?.framework || "this framework"} (options: ${(this.state.result?.supportedSplits || []).join(", ")}).`;
          delete next.splitBy;
          this.state.options = clean(next);
          this.regenerate();
        }
        if (!this.state.error && skipped) {
          applied = `⚠ YAML regenerated.${skipped}`;
        } else if (this.state.error) {
          applied = `⚠ Couldn't apply: ${this.state.error}`;
          this.restore(prev);
        } else applied = "YAML regenerated.";
        if (!applied.startsWith("⚠ Couldn't")) change = this.describeChange(prev, plan.explanations);
      } else if (plan.action === "replace_yaml" && plan.yaml) {
        const prev = this.snapshot();
        this.state.yaml = plan.yaml.replace(/^```(ya?ml)?\n|```\s*$/g, "");
        this.state.dirty = true;
        this.state.validation = strip(c.validateYaml(this.state.yaml, this.state.repo));
        applied = "YAML edited directly (option controls will overwrite these edits if you change them).";
        change = this.describeChange(prev, plan.explanations);
      }
      this.state.chat.push({ role: "assistant", text: plan.reply, applied, backend, sources, change });
    } catch (e) {
      this.state.chat.push({ role: "assistant", text: `Error: ${e.message}`, error: true });
    } finally {
      this.cts.dispose();
      this.cts = null;
      this.busy();
      this.push();
    }
  }

  async dryRun() {
    if (this.state.result?.yamlVersion === "0.2" || /^version:\s*["']?0\.2/m.test(this.state.yaml)) {
      return this.toast("v0.2 discovery runs on HyperExecute — check the discovery task log on the first run.");
    }
    const YAML = (await loadCore()).YAML || (await import(pathToFileURL(require.resolve("yaml")).href)).default;
    let doc;
    try {
      doc = YAML.parse(this.state.yaml);
    } catch (e) {
      return this.toast(`YAML parse error: ${e.message}`, "error");
    }
    const cmd = doc?.testDiscovery?.command;
    if (!cmd) {
      const n = doc?.matrix ? Object.values(doc.matrix).filter(Array.isArray).reduce((a, v) => a * v.length, 1) : 0;
      return this.post({ type: "dryRun", result: { matrix: true, tasks: n, matrixKeys: Object.keys(doc?.matrix || {}) } });
    }
    this.busy("Running discovery…");
    execFile("bash", ["-c", cmd], { cwd: this.state.repo, timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      this.busy();
      const items = stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      this.state.discoveredUnits = items.length || null;
      // remembered so the real run can be compared with it (discovery check)
      if (!err) core?.saveDryRun?.(this.state.repo, this.outputName(), { command: cmd, discovered: items.length, items });
      this.post({
        type: "dryRun",
        result: { command: cmd, count: items.length, items: items.slice(0, 200), stderr: stderr?.slice(0, 1000), exit: err ? err.code ?? 1 : 0, sample: doc.testRunnerCommand ? items.slice(0, 2).map((t) => doc.testRunnerCommand.replace(/\$test/g, t)) : [] },
      });
    });
  }

  async save(openAfter) {
    if (!this.state.repo) return;
    core?.recordChoice?.(this.state.profileFull, this.state.options);
    const target = vscode.Uri.file(path.join(this.state.repo, this.outputName()));
    if (fs.existsSync(target.fsPath) && fs.readFileSync(target.fsPath, "utf8") !== this.state.yaml && !this.state.overwriteOk) {
      const a = await vscode.window.showWarningMessage(`${this.outputName()} already exists in the repo. Overwrite it?`, { modal: true }, "Overwrite", "Show diff");
      if (a === "Show diff") {
        const tmp = vscode.Uri.file(path.join(require("os").tmpdir(), `he-proposed-${Date.now()}.yaml`));
        fs.writeFileSync(tmp.fsPath, this.state.yaml);
        return vscode.commands.executeCommand("vscode.diff", target, tmp, `${this.outputName()} ↔ Studio`);
      }
      if (a !== "Overwrite") return;
      this.state.overwriteOk = true;
    }
    fs.writeFileSync(target.fsPath, this.state.yaml);
    this.state.existingFile = this.outputName();
    this.logStep("Saved the YAML", this.outputName(), { pane: "yaml" });
    this.toast(`Saved ${this.outputName()}`);
    this.push();
    if (openAfter) await vscode.window.showTextDocument(target, { preview: false });
    return target;
  }

  // ---------- LambdaTest account (used by ▶ Run) ----------
  // Studio secret storage first, then the account saved by the MCP tool (~/.hyperexecute-studio).
  async ltAccount() {
    const username = this.context.globalState.get("hyperexecute.ltUsername") || "";
    const accessKey = (await this.context.secrets.get("hyperexecute.ltAccessKey")) || "";
    if (username && accessKey) return { username, accessKey, source: "vscode" };
    const c = await loadCore();
    const shared = c.loadCreds();
    if (shared) {
      await this.context.globalState.update("hyperexecute.ltUsername", shared.username);
      await this.context.secrets.store("hyperexecute.ltAccessKey", shared.accessKey);
      if (this.state.meta) Object.assign(this.state.meta, { ltUser: shared.username, ltReady: true });
      return { username: shared.username, accessKey: shared.accessKey, source: "shared" };
    }
    return { username: "", accessKey: "" };
  }

  async testLtAccount(username, accessKey) {
    try {
      const res = await fetch("https://api.lambdatest.com/automation/api/v1/builds?limit=1", {
        headers: { Authorization: "Basic " + Buffer.from(`${username}:${accessKey}`).toString("base64") },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 200) return { ok: true, text: `Connected as ${username}` };
      if (res.status === 401) return { ok: false, text: "Invalid username or access key (401)" };
      return { ok: false, text: `LambdaTest API returned ${res.status}` };
    } catch (e) {
      return { ok: false, text: `Could not reach LambdaTest: ${e.message}` };
    }
  }

  // ---------- credentials & reporting ----------
  async fixCredentials() {
    const c = await loadCore();
    const findings = c.scanCredentials(this.state.repo);
    const plans = c.planCredentialFixes(this.state.repo, findings);
    if (!plans.length) return this.toast("Nothing to replace automatically — check the manual items.");
    const n = plans.reduce((a, p) => a + p.edits.length, 0);
    const pick = await vscode.window.showWarningMessage(
      `Replace ${n} hard-coded credential(s) in ${plans.length} file(s) with LT_USERNAME / LT_ACCESS_KEY lookups?`,
      { modal: true, detail: plans.map((p) => `• ${p.file} (${p.edits.length})`).join("\n") + "\n\nYou can undo in each file (Cmd+Z) or with git." },
      "Replace",
      "Preview first file"
    );
    if (pick === "Preview first file") {
      const tmp = vscode.Uri.file(path.join(require("os").tmpdir(), `he-${Date.now()}-${path.basename(plans[0].file)}`));
      fs.writeFileSync(tmp.fsPath, plans[0].after);
      return vscode.commands.executeCommand("vscode.diff", vscode.Uri.file(path.join(this.state.repo, plans[0].file)), tmp, `${plans[0].file} ↔ with env vars`);
    }
    if (pick !== "Replace") return;
    const edit = new vscode.WorkspaceEdit();
    const docs = [];
    for (const p of plans) {
      const uri = vscode.Uri.file(path.join(this.state.repo, p.file));
      const doc = await vscode.workspace.openTextDocument(uri);
      edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), p.after);
      docs.push(doc);
    }
    await vscode.workspace.applyEdit(edit);
    for (const d of docs) await d.save();
    this.toast(`Replaced ${n} credential(s) in ${plans.length} file(s)`);
    this.logStep("Moved hard-coded credentials to environment variables", `${n} in ${plans.length} file(s)`, { pane: "setup", tone: "ok" });
    this.state.scan = c.scanRepo(this.state.repo);
    this.push();
  }

  async openFile(file, line) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(this.state.repo, file)));
    const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: true });
  }

  // ---------- capabilities ----------
  // where the repo connects, and the in-place change for each place; the Studio never creates or edits these files
  async capabilities(opts) {
    const c = await loadCore();
    const r = c.generateConnection(this.state.profileFull, opts);
    const points = c.planConnectionChanges(c.findDriverSetup(this.state.repo, this.state.profileFull), r);
    this.post({ type: "caps", result: { ...r, points } });
  }

  // ---------- Add to Confluence: a page documenting what was done for this repo ----------
  async publishConfluence() {
    if (!this.state.repo) return this.toast("Open a repo first");
    const c = await loadCore();
    let { email, token } = await applyAtlassianEnv(this.context);
    if (!email || !token) {
      await setAtlassian(this.context);
      ({ email, token } = await applyAtlassianEnv(this.context));
      if (!email || !token) return;
    }
    const cfg = vscode.workspace.getConfiguration("hyperexecute");
    const space = cfg.get("confluencePublishSpace") || "HYP";
    const doc = c.buildSetupReport(this.reportSession());
    const pick = await vscode.window.showInformationMessage(
      `Create a Confluence page in space ${space}?`,
      { modal: true, detail: `"${doc.title}"\n\nIt documents what was done for this repo: analysis, the YAML (credentials as secret references), runs, problems and fixes, what was learned and next steps.` },
      "Create page",
      "Preview"
    );
    if (pick === "Preview") {
      const md = await vscode.workspace.openTextDocument({ language: "markdown", content: doc.markdown });
      await vscode.window.showTextDocument(md, { preview: true });
      return this.toast("This is the page content. Click Add to Confluence again to create it.");
    }
    if (pick !== "Create page") return;
    this.busy("Creating the Confluence page…");
    try {
      const page = await c.createConfluencePage({ title: doc.title, storage: doc.storage, space, parentId: cfg.get("confluenceParentPageId") || undefined });
      c.cacheConfluencePage({ id: page.id, title: page.title, url: page.url, space: page.space, version: 1, content: doc.markdown });
      this.logStep("Added the setup to Confluence", page.title, { url: page.url, tone: "ok" });
      this.push();
      const open = await vscode.window.showInformationMessage(`Created "${page.title}" in Confluence.`, "Open page");
      if (open) vscode.env.openExternal(vscode.Uri.parse(page.url));
    } catch (e) {
      this.toast(`Couldn't create the page: ${e.message}`, "error");
    } finally {
      this.busy();
    }
  }

  reportSession() {
    const runs = this.state.run?.history || [];
    const steps = this.journals?.get(this.state.repo) || [];
    let connection = [];
    try { connection = core.findDriverSetup(this.state.repo, this.state.profileFull); } catch {}
    return {
      repoName: path.basename(this.state.repo),
      profile: this.state.profile,
      yaml: this.state.yaml,
      yamlFile: this.outputName(),
      validation: this.state.validation,
      options: this.state.options,
      runs,
      activity: steps,
      connection,
      scan: this.state.scan && { credentials: this.state.scan.credentials.length, credentialsFixed: 0, reporting: [...new Set((this.state.scan.reporting || []).map((x) => x.name).filter(Boolean))] },
      team: core.readTeamMemory?.(this.state.repo),
      learned: runs.map((h) => h.learned).filter(Boolean),
    };
  }

  // ---------- optimizer ----------
  async optimize() {
    const c = await loadCore();
    const r = c.optimizeYaml(this.state.yaml, { profile: this.state.profileFull, repoPath: this.state.repo, units: this.state.discoveredUnits });
    this.post({ type: "optimize", result: { units: r.units, error: r.error, suggestions: c.describeSuggestions(r.suggestions || []) } });
  }

  async applyOptimizations(ids) {
    const c = await loadCore();
    const r = c.applyOptimizations(this.state.yaml, ids, { profile: this.state.profileFull, repoPath: this.state.repo, units: this.state.discoveredUnits });
    this.logStep("Applied optimizations", Array.isArray(ids) ? ids.join(", ") : "all", { pane: "yaml" });
    if (Object.keys(r.regenerate).length) {
      this.state.options = clean({ ...this.state.options, ...r.regenerate, ...(r.regenerate.splitBy ? { executionMode: "autosplit" } : {}) });
      this.regenerate();
      this.push();
      this.toast(`Regenerated with ${Object.entries(r.regenerate).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    } else {
      this.state.yaml = r.yaml;
      this.state.dirty = true;
      this.state.validation = strip(c.validateYaml(r.yaml, this.state.repo));
      this.push();
      this.toast(`Applied ${r.applied.length} optimization(s)`);
    }
    await this.optimize();
  }

  async run(opts = {}) {
    if (this.runHandle) return this.toast("A run is already in progress");
    if (this.state.validation && !this.state.validation.valid) {
      const a = await vscode.window.showWarningMessage("The YAML has validation errors. Run anyway?", { modal: true }, "Run anyway");
      if (a !== "Run anyway") return;
    }
    const acct = await this.ltAccount();
    if (!acct.username || !acct.accessKey) {
      this.post({ type: "showPane", pane: "setup" });
      return this.toast("Add your LambdaTest username and access key in Setup first", "error");
    }
    if (this.state.scan?.credentials?.length) {
      const a = await vscode.window.showWarningMessage(
        `The repo still has ${this.state.scan.credentials.length} hard-coded credential(s), so some results may go to the customer's account.`,
        { modal: true },
        "Run anyway"
      );
      if (a !== "Run anyway") return;
    }
    const saved = await this.save(false);
    if (!saved) return;
    this.state.run = { auto: !!opts.auto, maxAttempts: Math.min(10, Math.max(1, +opts.maxAttempts || 3)), history: [], attempt: 0 };
    this.post({ type: "showPane", pane: "runs" });
    await this.startAttempt();
  }

  output() {
    if (!this.channel) this.channel = vscode.window.createOutputChannel("HyperExecute");
    return this.channel;
  }

  async startAttempt(config) {
    const c = await loadCore();
    const run = this.state.run;
    const acct = await this.ltAccount();
    let cli;
    try {
      this.busy("Preparing HyperExecute CLI…");
      cli = await c.ensureCli(this.state.repo);
    } catch (e) {
      this.busy();
      return this.toast(e.message, "error");
    }
    this.busy();
    run.attempt += 1;
    run.status = "running";
    run.startedAt = Date.now();
    run.jobUrl = null;
    run.diagnosis = null;
    run.tail = "";
    run.config = config || this.outputName();
    run.targeted = run.config !== this.outputName();
    this.logStep(`Started run ${run.attempt}${run.targeted ? " (affected tests only)" : ""}`, run.config, { pane: "runs" });
    this.push();
    const ch = this.output();
    ch.appendLine(`\n===== Attempt ${run.attempt}${run.targeted ? " (affected tests only)" : ""} — ${new Date().toLocaleTimeString()} =====`);
    let pending = "";
    const flush = () => { if (pending) { this.post({ type: "runLog", chunk: pending }); pending = ""; } };
    const timer = setInterval(flush, 400);
    const h = c.startRun({
      cli, repoPath: this.state.repo, config: run.config, username: acct.username, accessKey: acct.accessKey,
      onData: (s) => {
        ch.append(s);
        pending += s;
        run.tail = (run.tail + s).slice(-60000);
        const url = !run.jobUrl && run.tail.match(/https:\/\/[\w.-]*(hyperexecute|lambdatest|testmuai)[\w.-]*\/[^\s"')]*job[^\s"')]*/i);
        if (url) { run.jobUrl = url[0]; this.post({ type: "runMeta", jobUrl: run.jobUrl }); }
      },
    });
    this.runHandle = h;
    const r = await h.promise;
    clearInterval(timer);
    flush();
    this.runHandle = null;
    await this.finishAttempt(r);
  }

  async finishAttempt(r) {
    const c = await loadCore();
    const run = this.state.run;
    const evidence = c.collectEvidence({ output: r.output, repoPath: this.state.repo, since: r.startedAt, artifactsDir: r.artifactsDir });
    const yamlText = fs.readFileSync(path.join(this.state.repo, run.config || this.outputName()), "utf8");
    const d = c.diagnose({ evidence, yamlText, profile: this.state.profileFull, exitCode: r.exitCode, v02Name: c.v02FrameworkName(this.state.profileFull, this.state.profileFull.primaryFramework) });
    this.lastDiagnosis = d;
    this.lastEvidence = evidence;
    run.status = r.stopped ? "stopped" : d.status;
    run.discoveryCheck = c.checkDiscovery({ repo: this.state.repo, yamlPath: this.outputName(), yamlText, profile: this.state.profileFull, output: r.output, tests: evidence.tests, targeted: !!run.targeted });
    // a green job that ran 0 tests is not a pass
    if (run.discoveryCheck.verdict === "zero-tests" && ["passed", "passed-with-failures", "unknown"].includes(run.status)) run.status = "needs-attention";
    run.jobUrl = run.jobUrl || d.jobUrl;
    run.diagnosis = c.describeDiagnosis(d);
    const passed = ["passed", "passed-with-failures"].includes(run.status);
    run.failure = passed ? null : { headline: c.headline(evidence.text), ruleIds: d.diagnoses.map((x) => x.id), title: d.diagnoses[0]?.title };
    run.fixedBefore = run.failure ? c.findLearnedFix({ repo: this.state.repo, ...run.failure }) : null;
    // passed after a YAML fix: remember the failure and the change that fixed it
    run.learned = !r.stopped && passed && run.pendingFix ? c.recordFixThatWorked({ repo: this.state.repo, ...run.pendingFix, profile: this.state.profileFull, jobId: d.jobId }) : null;
    run.pendingFix = null;
    if (!r.stopped) {
      const { accessKey } = await this.ltAccount();
      run.savedForReview = !!c.recordUnmatched({ source: "studio-run", diagnosis: { ...d, status: run.status }, logText: evidence.text, profile: this.state.profileFull, yamlText, secrets: [accessKey] });
      c.recordOutcome({ event: "result", runId: `studio-${run.startedAt}-${run.attempt}`, attempt: run.attempt, status: run.status, ruleIds: d.diagnoses.map((x) => x.id), discovery: run.discoveryCheck.verdict, framework: this.state.profileFull.primaryFramework });
    }
    run.logFiles = evidence.files;
    const entry = { attempt: run.attempt, targeted: !!run.targeted, tests: d.tests, status: run.status, durationSec: Math.round((r.finishedAt - r.startedAt) / 1000), jobUrl: run.jobUrl, changes: [], problems: passed ? [] : d.diagnoses, headline: run.failure?.headline, learned: run.learned || undefined };
    run.history.push(entry);
    const zero = run.discoveryCheck?.verdict === "zero-tests";
    this.logStep(`Run ${run.attempt} finished`, `${run.status}${zero ? " · 0 tests ran" : ""}${d.diagnoses.length ? ` · ${d.diagnoses.map((x) => x.title).join("; ")}` : ""}${run.learned ? " · fix remembered" : ""}`, {
      pane: "runs",
      url: run.jobUrl || "",
      tone: r.stopped ? "warn" : run.status === "passed" && !zero ? "ok" : run.status === "passed-with-failures" ? "warn" : "bad",
    });
    this.push();
    if (r.stopped) return;
    if (["fixable", "fixable-tests"].includes(run.status) && run.auto && d.canAutoFix) {
      if (run.attempt >= run.maxAttempts) {
        run.note = `Stopped after ${run.maxAttempts} attempts — review the diagnosis.`;
        return this.push();
      }
      await this.applyRunFixes(null, true);
    }
    if (run.status === "passed" && !run.targeted) {
      run.savedCase = !!c.saveSuccessCase({ repo: this.state.repo, yamlText, profile: this.state.profileFull, jobId: d.jobId });
      c.recordTeamPass?.(this.state.repo, { options: this.state.options, configFile: this.outputName(), jobId: d.jobId, framework: this.state.profileFull?.primaryFramework });
    }
    if (["passed", "passed-with-failures"].includes(run.status)) {
      vscode.window.showInformationMessage(`HyperExecute job ${run.status === "passed" ? "passed" : "finished with test failures"} (attempt ${run.attempt}).`);
    }
  }

  // The built-in assistant (src/assistant.js): option changes, questions, pasted-log diagnosis,
  // optimize and CI pipelines, without any AI model.
  async builtInChat(c, text) {
    const reply = (t, applied = "", change = null) => { this.state.chat.push({ role: "assistant", text: t, applied, backend: "Built-in assistant", change }); this.push(); };
    const YAML = c.YAML || (await import(pathToFileURL(require.resolve("yaml")).href)).default;
    let parsed = {};
    try { parsed = YAML.parse(String(this.state.yaml || "").replace(/\$\{\{[^}]*\}\}/g, "x")) || {}; } catch {}
    if (/^(apply|use)\b.*\b(fix|fixed|corrected)\b/i.test(text.trim()) && this.pendingFix) {
      const prev = this.snapshot();
      Object.assign(this.state, { yaml: this.pendingFix, dirty: true });
      this.state.validation = strip(c.validateYaml(this.state.yaml, this.state.repo));
      this.pendingFix = null;
      return reply("Done: the corrected YAML is in the editor. Save it and run again.", "YAML edited directly.", this.describeChange(prev));
    }
    const ctx = { core: c, profile: this.state.profileFull, summary: c.summarizeProfile(this.state.profileFull, 40), result: this.state.result, yaml: this.state.yaml, validation: this.state.validation, parsed, scan: this.state.scan || { credentials: [], reporting: [] }, repoName: path.basename(this.state.repo || ""), credsOn: !!(this.state.meta?.embedCreds !== false && this.ltCreds), visitor: (s) => s };
    const plan = c.respond(text, ctx);
    if (plan.options) {
      const prev = this.snapshot();
      const next = { ...this.state.options };
      for (const [k, v] of Object.entries(plan.options)) {
        if (v === null || v === undefined) delete next[k];
        else if (k === "extraEnv" || k === "extraMatrix") next[k] = { ...(next[k] || {}), ...v };
        else next[k] = v;
      }
      this.state.options = clean(next);
      this.regenerate();
      if (this.state.error) {
        const err = this.state.error;
        this.restore(prev);
        return reply(`I couldn't apply that: ${err}`);
      }
      return reply(`Done: ${plan.done.join(" · ")}.`, "YAML regenerated.", this.describeChange(prev));
    }
    if (plan.reset) {
      const prev = this.snapshot();
      this.state.options = {};
      this.regenerate();
      return reply("Back to the detected defaults.", "YAML regenerated.", this.describeChange(prev));
    }
    if (plan.undo) return this.undo();
    if (plan.diagnose) {
      const d = c.diagnose({ evidence: c.collectEvidence({ output: plan.diagnose }), yamlText: this.state.yaml, profile: this.state.profileFull, exitCode: 1, v02Name: c.v02FrameworkName(this.state.profileFull, this.state.profileFull.primaryFramework) });
      const lines = [`Diagnosis: **${d.status}**.`, ...d.diagnoses.slice(0, 4).map((x) => `- **${x.title}**: ${x.why}${x.fixSummary ? ` Fix: ${x.fixSummary}.` : ""}`)];
      if (d._fixes.length) {
        let next = c.applyDiagnosisFixes(this.state.yaml, d);
        if (Object.keys(next.options).length) next = c.applyDiagnosisFixes(c.generateYaml(this.state.profileFull, this.genOptions(next.options)).yaml, d, d._fixes.filter((f) => f.patch).map((f) => f.id));
        if (next.yaml !== this.state.yaml) { this.pendingFix = next.yaml; lines.push("I prepared a corrected YAML. Say **apply the fix** to put it in the editor."); }
      } else if (!d.diagnoses.length) lines.push("No known failure pattern matched.");
      return reply(lines.join("\n"));
    }
    if (plan.optimize) {
      const o = c.optimizeYaml(this.state.yaml, { profile: this.state.profileFull, repoPath: this.state.repo });
      const list = c.describeSuggestions(o.suggestions || []);
      return reply(list.length ? `${list.length} improvement(s):\n${list.map((s) => `- **${s.title}** (${s.severity}): ${s.why}`).join("\n")}\nApply them with **Optimize** in the YAML tab.` : "Nothing to optimize: this YAML already follows the recommendations.");
    }
    if (plan.pipeline) {
      if (plan.pipeline === "ask") return reply("Which CI? Say GitHub Actions, GitLab, Jenkins or Azure DevOps.");
      const p = c.generatePipeline({ ci: plan.pipeline, configFile: this.outputName(), yaml: this.state.yaml });
      this.logStep("Prepared a CI pipeline", p.path, { chat: false });
      const doc = await vscode.workspace.openTextDocument({ content: p.content, language: p.path.endsWith("Jenkinsfile") ? "groovy" : "yaml" });
      await vscode.window.showTextDocument(doc, { preview: false });
      return reply(`Opened **${p.path}** for ${p.name} in an editor tab. Save it at that path in the repo.\n${p.notes.map((n) => `- ${n}`).join("\n")}`);
    }
    return reply(plan.reply + (plan.ai ? "\n\nFor free-form requests, choose an AI backend (HyperExecute: Choose AI Backend)." : ""));
  }

  // Apply the diagnosis's YAML fixes (or the AI's), save, and start the next attempt.
  async applyRunFixes(ids, rerun, values = {}) {
    const c = await loadCore();
    const d = this.lastDiagnosis;
    if (!d) return;
    const run = this.state.run;
    const before = this.state.yaml;
    let r = c.applyDiagnosisFixes(this.state.yaml, d, ids, values);
    if (Object.keys(r.options).length) {
      this.state.options = clean({ ...this.state.options, ...r.options });
      this.regenerate();
      r = { ...c.applyDiagnosisFixes(this.state.yaml, d, d._fixes.filter((f) => f.patch && (!ids || ids.includes(f.id))).map((f) => f.id), values), applied: r.applied };
    }
    this.state.yaml = r.yaml;
    this.state.dirty = true;
    this.state.validation = strip(c.validateYaml(r.yaml, this.state.repo));
    if (!this.state.validation.valid) {
      this.push();
      return this.toast(`Fixed YAML has errors: ${this.state.validation.errors[0]}`, "error");
    }
    run.history[run.history.length - 1].changes.push(...r.applied);
    run.pendingFix = { failure: run.failure, before, after: this.state.yaml, how: "rules", applied: r.applied };
    this.logStep("Fixed the YAML", r.applied.join("; "), { pane: "yaml", tone: "ok" });
    this.state.overwriteOk = true;
    await this.save(false);
    this.state.dirty = false;
    this.push();
    if (!rerun) return;
    // Only some tests failed for YAML reasons → rerun just those; code failures are left alone.
    const sels = c.fixableSelectors(d, values);
    if (d.status === "fixable-tests" && !d.fullRerunNeeded && sels.length) {
      const rerunYaml = c.buildTargetedRerun({
        fixedYaml: this.state.yaml,
        selectors: sels,
        profile: this.state.profileFull,
        generate: (o) => c.generateYaml(this.state.profileFull, this.genOptions(o)).yaml,
      });
      if (rerunYaml) {
        fs.writeFileSync(path.join(this.state.repo, ".hyperexecute-rerun.yaml"), rerunYaml);
        run.history[run.history.length - 1].changes.push(`rerun only ${sels.length} affected test(s)`);
        return this.startAttempt(".hyperexecute-rerun.yaml");
      }
    }
    await this.startAttempt();
  }

  // No rule matched: ask the AI backend for a YAML change based on the log digest.
  async askAiForRunFix() {
    const c = await loadCore();
    const run = this.state.run;
    if (!this.lastEvidence) return;
    this.busy("Thinking…");
    try {
      const context = {
        task: "A HyperExecute job failed. Propose the YAML change that fixes it (replace_yaml with the full corrected YAML, or update_options). If the failure is in the tests or application, answer_only and explain.",
        currentYaml: this.state.yaml,
        diagnosis: run.diagnosis,
        fixedBefore: run.fixedBefore ? { note: "This failure was fixed before with this YAML change and the next run passed. Prefer it if it fits.", change: run.fixedBefore.change } : undefined,
        logDigest: c.logDigest(this.lastEvidence),
        analysis: c.summarizeProfile(this.state.profileFull, 10),
      };
      const { plan, backend } = await ai.plan(this.context, context, "Fix the failed HyperExecute run.", undefined);
      run.aiSuggestion = { reply: plan.reply, backend, action: plan.action };
      if (plan.action === "replace_yaml" && plan.yaml) {
        const yaml = plan.yaml.replace(/^```(ya?ml)?\n|```\s*$/g, "");
        const v = c.validateYaml(yaml, this.state.repo);
        run.aiSuggestion.yaml = yaml;
        run.aiSuggestion.valid = v.valid;
        run.aiSuggestion.errors = v.errors;
      } else if (plan.action === "update_options") {
        const next = { ...this.state.options };
        for (const [k, v] of Object.entries(plan.options || {})) if (v !== null && v !== undefined) next[k] = k === "extraMatrix" ? Object.fromEntries(v.map((a) => [a.key, a.values])) : k === "extraEnv" ? Object.fromEntries(v.map((a) => [a.name, a.value])) : v;
        run.aiSuggestion.options = clean(next);
      }
    } catch (e) {
      run.aiSuggestion = { reply: `Error: ${e.message}` };
    } finally {
      this.busy();
      this.push();
    }
  }

  async applyAiRunFix(rerun) {
    const c = await loadCore();
    const run = this.state.run;
    const s = run.aiSuggestion;
    if (!s) return;
    const before = this.state.yaml;
    if (s.options) {
      this.state.options = s.options;
      this.regenerate();
    } else if (s.yaml && s.valid) {
      this.state.yaml = s.yaml;
      this.state.validation = strip(c.validateYaml(s.yaml, this.state.repo));
    } else return this.toast("The AI suggestion isn't a valid YAML change", "error");
    run.history[run.history.length - 1].changes.push(`AI: ${s.reply.slice(0, 120)}`);
    run.pendingFix = { failure: run.failure, before, after: this.state.yaml, how: "ai", applied: [`AI: ${s.reply.slice(0, 120)}`] };
    this.logStep("Fixed the YAML with the AI's change", s.reply.slice(0, 160), { pane: "yaml", tone: "ok" });
    run.aiSuggestion = null;
    this.state.overwriteOk = true;
    await this.save(false);
    this.push();
    if (rerun) await this.startAttempt();
  }

  // Rerun every failed test as-is (e.g. to check flakiness) without changing the YAML.
  buildFailedOnlyRerun() {
    const d = this.lastDiagnosis;
    const sels = d.tests.list.map((t) => t.selector).filter(Boolean);
    if (!sels.length || !core) return undefined;
    const y = core.buildTargetedRerun({ fixedYaml: this.state.yaml, selectors: sels, profile: this.state.profileFull, generate: (o) => core.generateYaml(this.state.profileFull, this.genOptions(o)).yaml });
    if (!y) return undefined;
    fs.writeFileSync(path.join(this.state.repo, ".hyperexecute-rerun.yaml"), y);
    return ".hyperexecute-rerun.yaml";
  }

  stopRun() {
    if (this.runHandle) {
      this.runHandle.stop();
      this.toast("Stopping the CLI…");
    }
  }


  html() {
    const w = this.webview;
    const media = (f) => w.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", f)));
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; img-src ${w.cspSource} data:; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("studio.css")}"><title>HyperExecute Studio</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${media("studio.js")}"></script></body></html>`;
  }
}

// ---------- the YAML file in the editor: problems, quick fixes, links above it, status bar ----------

let statusItem;
const isHeYaml = (doc) => doc?.languageId === "yaml" && /hyperexecute.*\.ya?ml$/i.test(path.basename(doc.fileName));

// Squiggles + Problems panel from the same validator the Studio uses, quick fixes for the problems
// that can be fixed by editing text, and links above the file (status, ▶ Run, Explain, Studio).
function registerYamlTools(context) {
  const diags = vscode.languages.createDiagnosticCollection("hyperexecute");
  const results = new Map(); // uri → { errors, warnings }
  const lensChanged = new vscode.EventEmitter();
  const S = vscode.DiagnosticSeverity;
  const check = async (doc) => {
    if (!isHeYaml(doc)) return;
    const c = await loadCore();
    const text = doc.getText();
    let v;
    try { v = c.validateYaml(text, vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath); } catch (e) { v = { errors: [e.message], warnings: [], info: [] }; }
    const at = (msg, sev) => {
      const line = doc.lineAt(Math.min(Math.max(c.locateYamlMessage(text, msg) - 1, 0), doc.lineCount - 1));
      const d = new vscode.Diagnostic(new vscode.Range(line.lineNumber, line.firstNonWhitespaceCharacterIndex, line.lineNumber, line.text.length), String(msg).split("\n")[0], sev);
      d.source = "HyperExecute";
      return d;
    };
    diags.set(doc.uri, [...v.errors.map((m) => at(m, S.Error)), ...v.warnings.map((m) => at(m, S.Warning)), ...(v.info || []).map((m) => at(m, S.Information))]);
    results.set(doc.uri.toString(), { errors: v.errors.length, warnings: v.warnings.length });
    lensChanged.fire();
  };
  const timers = new Map();
  const later = (doc) => { clearTimeout(timers.get(doc.uri.toString())); timers.set(doc.uri.toString(), setTimeout(() => check(doc), 400)); };
  const sel = { language: "yaml", pattern: "**/*hyperexecute*.{yml,yaml}" };
  context.subscriptions.push(
    diags,
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((e) => isHeYaml(e.document) && later(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => { diags.delete(d.uri); results.delete(d.uri.toString()); }),
    vscode.languages.registerCodeActionsProvider(sel, {
      async provideCodeActions(doc, _range, ctx) {
        const c = await loadCore();
        const text = doc.getText();
        const actions = [];
        for (const d of ctx.diagnostics.filter((x) => x.source === "HyperExecute")) {
          const fixes = c.yamlMessageFixes(text, d.message);
          for (const f of fixes) {
            const a = new vscode.CodeAction(f.title, vscode.CodeActionKind.QuickFix);
            a.edit = new vscode.WorkspaceEdit();
            for (const e of f.edits) {
              // whole lines, with their line breaks (to the start of the next line, or the end of the file)
              if (e.remove) a.edit.delete(doc.uri, e.to < doc.lineCount ? new vscode.Range(e.from - 1, 0, e.to, 0) : new vscode.Range(Math.max(e.from - 2, 0), e.from > 1 ? doc.lineAt(e.from - 2).text.length : 0, e.to - 1, doc.lineAt(e.to - 1).text.length));
              else if (e.insert !== undefined) a.edit.insert(doc.uri, new vscode.Position(e.line - 1, 0), e.insert + "\n");
              else a.edit.replace(doc.uri, doc.lineAt(e.line - 1).range, e.text);
            }
            a.diagnostics = [d];
            a.isPreferred = fixes.length === 1;
            actions.push(a);
          }
        }
        return actions;
      },
    }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.languages.registerCodeLensProvider(sel, {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses(doc) {
        const top = new vscode.Range(0, 0, 0, 0);
        const r = results.get(doc.uri.toString());
        const folder = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
        const outName = vscode.workspace.getConfiguration("hyperexecute").get("outputFileName") || "hyperexecute.yaml";
        const lenses = [];
        if (r) lenses.push(new vscode.CodeLens(top, { title: `${r.errors ? `✕ ${r.errors} error${r.errors > 1 ? "s" : ""}` : "✓ Valid"}${r.warnings ? ` · ${r.warnings} warning${r.warnings > 1 ? "s" : ""}` : ""}`, command: "workbench.actions.view.problems", tooltip: "Show in the Problems panel" }));
        // only the Studio's own file: running it loads it into the Studio, which saves to this path
        if (folder && path.relative(folder, doc.uri.fsPath) === outName) lenses.push(new vscode.CodeLens(top, { title: "▶ Run on HyperExecute", command: "hyperexecute.runFile", arguments: [doc.uri], tooltip: "Run this file on HyperExecute and watch it in the Studio" }));
        lenses.push(new vscode.CodeLens(top, { title: "Explain line by line", command: "hyperexecute.annotateActiveFile", arguments: [doc.uri], tooltip: "Open a copy with each line's explanation as a comment" }));
        lenses.push(new vscode.CodeLens(top, { title: "Open Studio", command: "hyperexecute.openStudio" }));
        return lenses;
      },
    })
  );
  vscode.workspace.textDocuments.forEach(check);
}

// The status bar says where things stand and opens the matching tab. An update notice keeps priority.
function updateStatus(state) {
  const s = statusItem;
  if (!s || s.command === "workbench.action.reloadWindow") return;
  const r = state.run, v = state.validation;
  const ran = !!r?.history?.length;
  let text = "$(rocket) HyperExecute", tip = "Open HyperExecute Studio", pane, bg;
  if (r?.status === "running") [text, tip, pane] = [`$(sync~spin) HyperExecute: run ${r.attempt}`, "A HyperExecute job is running. Click to watch it.", "runs"];
  else if (ran && r.status === "passed") [text, tip, pane] = ["$(pass) HyperExecute: passed", "The last run passed. Click for details.", "runs"];
  else if (ran && r.status === "passed-with-failures") [text, tip, pane] = ["$(warning) HyperExecute: tests failed", "The job ran, but some tests failed. Click for details.", "runs"];
  else if (ran && r.status !== "stopped") [text, tip, pane, bg] = [`$(error) HyperExecute: run ${r.attempt} failed`, "The last run failed. Click to see why.", "runs", new vscode.ThemeColor("statusBarItem.errorBackground")];
  else if (v?.errors?.length) [text, tip, pane] = [`$(warning) HyperExecute: ${v.errors.length} error${v.errors.length > 1 ? "s" : ""}`, "The YAML has errors. Click to see them.", "yaml"];
  else if (v) [text, tip] = ["$(check) HyperExecute", "The YAML is valid. Click to open the Studio."];
  s.text = text;
  s.tooltip = tip;
  s.command = { command: "hyperexecute.openStudio", title: "Open HyperExecute Studio", arguments: pane ? [pane] : [] };
  s.backgroundColor = bg;
}

// The YAML with each line's explanation as a comment above it, in a new editor tab (not saved anywhere).
async function openAnnotated(yamlText, name) {
  const c = await loadCore();
  const content = `# ${name}, explained line by line by HyperExecute Studio. Comments only: it runs the same as the original.\n${c.annotateYaml(yamlText || "")}\n`;
  const doc = await vscode.workspace.openTextDocument({ content, language: "yaml" });
  await vscode.window.showTextDocument(doc, { preview: false });
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}
function strip(v) {
  const { parsed, ...rest } = v;
  return rest;
}

function deactivate() {}
module.exports = { activate, deactivate, _checkForUpdate: checkForUpdate };
