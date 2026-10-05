// Verifies the "reload to update" prompt: running 1.3.0, then 1.4.0 gets installed.
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "he-exts-"));
const running = path.join(extDir, "roshank-lambdatest.hyperexecute-yaml-studio-1.3.0");
fs.mkdirSync(running);
fs.writeFileSync(path.join(extDir, "extensions.json"), JSON.stringify([{ identifier: { id: "roshank-lambdatest.hyperexecute-yaml-studio" }, version: "1.3.0" }]));

const shown = [], executed = [];
let status;
const noop = () => ({ dispose() {} });
const vscodeStub = {
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, d) => d }), onDidChangeConfiguration: noop, onDidChangeWorkspaceFolders: noop },
  window: {
    createStatusBarItem: () => (status = { text: "", show() {}, dispose() {} }),
    registerWebviewViewProvider: noop,
    onDidChangeWindowState: noop,
    showInformationMessage: async (msg, ...btns) => { shown.push(msg); return btns[0]; },
  },
  commands: { registerCommand: noop, executeCommand: async (id) => executed.push(id) },
  extensions: { onDidChange: noop },
  lm: {},
  ThemeColor: class { constructor(id) { this.id = id; } },
  EventEmitter: class { constructor() { this.event = noop; } fire() {} },
  Uri: { file: (p) => ({ fsPath: p }) },
  StatusBarAlignment: { Right: 2 },
};
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) { return r === "vscode" ? "vscode" : orig.call(this, r, ...a); };
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

const ext = require("../extension.js");
const ctx = {
  extensionPath: running,
  extension: { packageJSON: { publisher: "roshank-lambdatest", name: "hyperexecute-yaml-studio", version: "1.3.0" } },
  subscriptions: [],
  secrets: { get: async () => undefined, onDidChange: noop },
  globalState: { get: () => undefined },
  workspaceState: { get: (k, d) => d },
};
let fails = 0;
const check = (l, c) => { console.log(`${c ? "PASS" : "FAIL"}  ${l}`); if (!c) fails++; };

(async () => {
  ext.activate(ctx);
  await new Promise((r) => setTimeout(r, 100));
  check("no prompt when running the newest version", shown.length === 0 && !/reload/.test(status.text));

  // install 1.4.0 while the window is running
  fs.mkdirSync(path.join(extDir, "roshank-lambdatest.hyperexecute-yaml-studio-1.4.0"));
  fs.writeFileSync(path.join(extDir, "extensions.json"), JSON.stringify([{ identifier: { id: "roshank-lambdatest.hyperexecute-yaml-studio" }, version: "1.4.0" }]));
  await new Promise((r) => setTimeout(r, 2500)); // fs.watch + debounce
  check("prompt names the new and running versions", shown.length === 1 && /1\.4\.0/.test(shown[0]) && /1\.3\.0/.test(shown[0]));
  check("status bar switches to reload", /reload to update/.test(status.text) && status.command === "workbench.action.reloadWindow");
  check("Reload Window runs the reload command", executed.includes("workbench.action.reloadWindow"));
  await new Promise((r) => setTimeout(r, 2000));
  check("prompt shown only once per version", shown.length === 1);
  for (const s of ctx.subscriptions) try { s.dispose(); } catch {}

  // ---- the GitHub check: frequent, conditional (ETag), and a version is offered at most once a day ----
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "he-exts-"));
  const run2 = path.join(dir2, "roshank-lambdatest.hyperexecute-yaml-studio-1.3.0");
  fs.mkdirSync(run2);
  fs.writeFileSync(path.join(dir2, "extensions.json"), JSON.stringify([{ identifier: { id: "roshank-lambdatest.hyperexecute-yaml-studio" }, version: "1.3.0" }]));
  const state = new Map();
  const ctx2 = { ...ctx, extensionPath: run2, subscriptions: [], globalState: { get: (k) => state.get(k), update: async (k, v) => state.set(k, v) } };
  const calls = [];
  global.fetch = async (url, o = {}) => {
    calls.push(o.headers?.["If-None-Match"] || null);
    if (o.headers?.["If-None-Match"] === '"v140"') return { status: 304, ok: false, headers: { get: () => '"v140"' } };
    return { status: 200, ok: true, headers: { get: (h) => (h === "etag" ? '"v140"' : null) }, json: async () => ({ tag_name: "v1.4.0", html_url: "https://github.com/x", assets: [{ name: "hyperexecute-studio.vsix", browser_download_url: "https://github.com/roshanLambdatest/HyperMCP/releases/download/v1.4.0/hyperexecute-studio.vsix", digest: "sha256:" + "a".repeat(64) }] }) };
  };
  shown.length = 0;
  vscodeStub.window.showInformationMessage = async (msg) => { shown.push(msg); return undefined; };
  await ext._checkForUpdate(ctx2, false);
  check("a newer release is offered on the first check", shown.length === 1 && /1\.4\.0 is available/.test(shown[0]));
  await ext._checkForUpdate(ctx2, false);
  check("checks within a few minutes are skipped", calls.length === 1 && shown.length === 1);
  state.set("hyperexecute.updateCheckedAt", 0); // 5 minutes later
  await ext._checkForUpdate(ctx2, false);
  check("the next check is conditional (ETag → 304) and uses the cached release", calls[1] === '"v140"' && calls.length === 2);
  check("the same version isn't offered again the same day", shown.length === 1);
  state.set("hyperexecute.updateCheckedAt", 0);
  state.set("hyperexecute.offered", { version: "1.4.0", at: Date.now() - 25 * 3600 * 1000 });
  await ext._checkForUpdate(ctx2, false);
  check("a day later it is offered again", shown.length === 2);
  await ext._checkForUpdate(ctx2, true);
  check("a manual check always answers", shown.length === 3);
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})();
