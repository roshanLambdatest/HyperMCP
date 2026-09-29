// HyperExecute YAML Studio — VS Code extension host side.
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
    const imp = (f) => import(pathToFileURL(path.join(__dirname, "core", f)).href);
    const mods = await Promise.all(["analyzer.js", "generator.js", "validator.js", "knowledge.js", "confluence.js"].map(imp));
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
  status.tooltip = "Open HyperExecute YAML Studio";
  status.command = "hyperexecute.openStudio";
  status.show();
  context.subscriptions.push(status);

  registerMcpServer(context);
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
        return [new vscode.McpStdioServerDefinition("HyperExecute YAML", process.execPath, [path.join(__dirname, "core", "index.js")], env, "1.0.0")];
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
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "AI backend for the YAML Studio chat" });
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
    this.state.meta = { backend: ai.LABELS[b.name], backendId: b.name, confluence: !!(email && token), confluenceSpace: vscode.workspace.getConfiguration("hyperexecute").get("confluenceSpace") || "HYP" };
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
        await this.run();
        break;
      case "openLink":
        if (/^https:\/\//.test(m.url)) vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      case "command":
        if (m.id?.startsWith("hyperexecute.")) await vscode.commands.executeCommand(m.id);
        break;
      case "clearChat":
        this.state.chat = [];
        this.push();
        break;
    }
  }

  async analyze(repoPath) {
    if (!repoPath) return;
    const c = await loadCore();
    this.busy("Analyzing repo…");
    try {
      this.state.repo = repoPath;
      this.state.profileFull = c.analyzeRepo(repoPath);
      this.state.profile = c.summarizeProfile(this.state.profileFull, 25);
      this.state.options = this.context.workspaceState.get(this.optionsKey(), {});
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

  regenerate() {
    const c = core;
    try {
      const r = c.generateYaml(this.state.profileFull, { ...this.state.options, outputFileName: this.outputName() });
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
    const YAML = (await import(pathToFileURL(require.resolve("yaml")).href)).default;
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
      this.post({
        type: "dryRun",
        result: { command: cmd, count: items.length, items: items.slice(0, 200), stderr: stderr?.slice(0, 1000), exit: err ? err.code ?? 1 : 0, sample: doc.testRunnerCommand ? items.slice(0, 2).map((t) => doc.testRunnerCommand.replace(/\$test/g, t)) : [] },
      });
    });
  }

  async save(openAfter) {
    if (!this.state.repo) return;
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
    this.toast(`Saved ${this.outputName()}`);
    this.push();
    if (openAfter) await vscode.window.showTextDocument(target, { preview: false });
    return target;
  }

  async run() {
    if (this.state.validation && !this.state.validation.valid) {
      const a = await vscode.window.showWarningMessage("The YAML has validation errors. Run anyway?", { modal: true }, "Run anyway");
      if (a !== "Run anyway") return;
    }
    const saved = await this.save(false);
    if (!saved) return;
    const cli = ["hyperexecute", "hyperexecute.exe"].map((f) => path.join(this.state.repo, f)).find((p) => fs.existsSync(p));
    if (!cli) {
      const a = await vscode.window.showWarningMessage("HyperExecute CLI not found in the repo root.", "Download instructions");
      if (a) vscode.env.openExternal(vscode.Uri.parse("https://www.lambdatest.com/support/docs/hyperexecute-cli-run-tests-on-hyperexecute-grid/"));
      return;
    }
    const term = vscode.window.createTerminal({ name: "HyperExecute", cwd: this.state.repo });
    term.show();
    term.sendText(`./${path.basename(cli)} --user "$LT_USERNAME" --key "$LT_ACCESS_KEY" --config ${this.outputName()}`);
  }

  html() {
    const w = this.webview;
    const media = (f) => w.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, "media", f)));
    const nonce = crypto.randomBytes(16).toString("base64");
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; img-src ${w.cspSource} data:; font-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${media("studio.css")}"><title>HyperExecute YAML Studio</title></head>
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
