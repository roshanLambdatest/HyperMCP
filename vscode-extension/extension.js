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
    const mods = await Promise.all(["analyzer.js", "generator.js", "validator.js", "knowledge.js", "confluence.js", "security.js", "capabilities.js", "optimizer.js", "runner.js", "doctor.js", "credentials.js", "feedback.js", "discovery-check.js", "assistant.js", "names.js", "pipelines.js", "learning.js", "report.js"].map(imp));
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
  return { email: cfg.get("atlassianEmail"), token };
}

function activate(context) {
  const studio = new Studio(context);
  Studio.current = studio;
  const open = async () => {
    await vscode.commands.executeCommand("workbench.view.extension.hyperexecute");
    await vscode.commands.executeCommand("hyperexecute.studio.focus");
  };
  context.subscriptions.push(
    vscode.commands.registerCommand("hyperexecute.openStudio", open),
    vscode.commands.registerCommand("hyperexecute.setAtlassianToken", () => setAtlassian(context)),
    vscode.commands.registerCommand("hyperexecute.addToConfluence", () => studio.publishConfluence()),
    vscode.commands.registerCommand("hyperexecute.setAnthropicKey", () => setAnthropicKey(context)),
    vscode.commands.registerCommand("hyperexecute.chooseBackend", () => chooseBackend(context)),
    vscode.commands.registerCommand("hyperexecute.validateActiveFile", () => validateActive()),
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

  registerMcpServer(context);
  watchForNewerVersion(context, status);
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
    this.post({ type: "state", state: this.state });
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
        this.post({ type: "validation", validation: this.state.validation, dirty: true });
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
        if (m.id?.startsWith("hyperexecute.")) await vscode.commands.executeCommand(m.id);
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
      case "clearChat":
        this.state.chat = [];
        this.push();
        break;
    }
  }

  // What was done per repo in this window, for "Add to Confluence".
  logStep(step, detail) {
    if (!this.state.repo) return;
    this.journals ||= new Map();
    const list = this.journals.get(this.state.repo) || [];
    list.push({ at: Date.now(), step, detail: detail ? String(detail).slice(0, 300) : undefined });
    this.journals.set(this.state.repo, list.slice(-100));
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
      this.logStep("Analyzed the repo", `${this.state.profileFull.primaryFramework || "no framework"} · ${this.state.scan.credentials.length} hard-coded credential(s)`);
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
    // No AI backend: the shared built-in assistant (same as the web version) handles the request.
    if ((await ai.detectBackend(this.context)).name === "rules") return this.builtInChat(c, text);
    this.busy("Thinking…");
    this.cts = new vscode.CancellationTokenSource();
    try {
      // Knowledge: bundled notes + Confluence
      const kb = c.searchKnowledge(`${text} ${this.state.result?.framework || ""}`, 3).map((d) => ({ source: "bundled", title: `${d.topic} › ${d.section}`, text: d.text.slice(0, 1500) }));
      const sources = [];
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
        history: this.state.chat.slice(-9, -1).map((m) => ({ role: m.role, text: m.text })),
      };
      const { plan, backend } = await ai.plan(this.context, context, text, this.cts.token);
      let applied = "";
      if (plan.action === "update_options") {
        const next = { ...this.state.options };
        for (const k of plan.resetOptions || []) delete next[k];
        for (const [k, v] of Object.entries(plan.options || {})) {
          if (v === null || v === undefined) continue;
          if (k === "extraMatrix") next[k] = Object.fromEntries(v.map((a) => [a.key, a.values]));
          else if (k === "extraEnv") next[k] = Object.fromEntries(v.map((a) => [a.name, a.value]));
          else next[k] = v;
        }
        const prev = { options: this.state.options, yaml: this.state.yaml, result: this.state.result };
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
          Object.assign(this.state, prev, { error: null, dirty: false });
          this.state.validation = strip(c.validateYaml(this.state.yaml, this.state.repo));
        } else applied = "YAML regenerated.";
      } else if (plan.action === "replace_yaml" && plan.yaml) {
        this.state.yaml = plan.yaml.replace(/^```(ya?ml)?\n|```\s*$/g, "");
        this.state.dirty = true;
        this.state.validation = strip(c.validateYaml(this.state.yaml, this.state.repo));
        applied = "YAML edited directly (option controls will overwrite these edits if you change them).";
      }
      this.state.chat.push({ role: "assistant", text: plan.reply, applied, backend, sources });
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
    this.logStep("Saved the YAML", this.outputName());
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
    this.logStep("Moved hard-coded credentials to environment variables", `${n} in ${plans.length} file(s)`);
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
      this.logStep("Added the setup to Confluence", page.url);
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
    this.logStep("Applied optimizations", Array.isArray(ids) ? ids.join(", ") : "all");
    if (Object.keys(r.regenerate).length) {
      this.state.options = clean({ ...this.state.options, ...r.regenerate, ...(r.regenerate.splitBy ? { executionMode: "autosplit" } : {}) });
      this.regenerate();
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
    this.logStep(`Started run ${run.attempt}${run.targeted ? " (affected tests only)" : ""}`);
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
    this.logStep(`Run ${run.attempt} finished`, `${run.status}${d.diagnoses.length ? ` · ${d.diagnoses.map((x) => x.title).join("; ")}` : ""}${run.learned ? " · fix remembered" : ""}`);
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
    const reply = (t, applied = "") => { this.state.chat.push({ role: "assistant", text: t, applied, backend: "Built-in assistant" }); this.push(); };
    const YAML = c.YAML || (await import(pathToFileURL(require.resolve("yaml")).href)).default;
    let parsed = {};
    try { parsed = YAML.parse(String(this.state.yaml || "").replace(/\$\{\{[^}]*\}\}/g, "x")) || {}; } catch {}
    if (/^(apply|use)\b.*\b(fix|fixed|corrected)\b/i.test(text.trim()) && this.pendingFix) {
      Object.assign(this.state, { yaml: this.pendingFix, dirty: true });
      this.state.validation = strip(c.validateYaml(this.state.yaml, this.state.repo));
      this.pendingFix = null;
      return reply("Done: the corrected YAML is in the editor. Save it and run again.", "YAML edited directly.");
    }
    const ctx = { core: c, profile: this.state.profileFull, summary: c.summarizeProfile(this.state.profileFull, 40), result: this.state.result, yaml: this.state.yaml, validation: this.state.validation, parsed, scan: this.state.scan || { credentials: [], reporting: [] }, repoName: path.basename(this.state.repo || ""), credsOn: !!(this.state.meta?.embedCreds !== false && this.ltCreds), visitor: (s) => s };
    const plan = c.respond(text, ctx);
    if (plan.options) {
      const prev = { options: this.state.options, yaml: this.state.yaml, result: this.state.result };
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
        Object.assign(this.state, prev, { error: null, dirty: false });
        this.state.validation = strip(c.validateYaml(this.state.yaml, this.state.repo));
        return reply(`I couldn't apply that: ${err}`);
      }
      return reply(`Done: ${plan.done.join(" · ")}.`, "YAML regenerated.");
    }
    if (plan.reset) { this.state.options = {}; this.regenerate(); return reply("Back to the detected defaults.", "YAML regenerated."); }
    if (plan.undo) return reply("The Studio chat has no undo yet: use Reset under Setup → Options, or change the option back.");
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
      this.logStep("Prepared a CI pipeline", p.path);
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
    this.logStep("Fixed the YAML", r.applied.join("; "));
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
    this.logStep("Fixed the YAML with the AI's change", s.reply.slice(0, 160));
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

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ""));
}
function strip(v) {
  const { parsed, ...rest } = v;
  return rest;
}

function deactivate() {}
module.exports = { activate, deactivate };
