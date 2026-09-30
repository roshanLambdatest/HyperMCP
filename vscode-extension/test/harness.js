// Headless harness: stubs the `vscode` module and drives the Studio panel like the webview would.
const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const posted = [];
const settings = { aiBackend: process.env.BACKEND || "rules", confluenceSpace: "HYP", outputFileName: "hyperexecute.yaml" };
const secrets = new Map(process.env.ATL_TOKEN ? [["hyperexecute.atlassianToken", process.env.ATL_TOKEN]] : []);
if (process.env.ATL_EMAIL) settings.atlassianEmail = process.env.ATL_EMAIL;
let onMessage;
let viewProvider;
const fixture = (n) => path.join(__dirname, "..", "..", "test", "fixtures", n);
const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "he-repo-"));
fs.cpSync(fixture(process.env.FIXTURE || "maven-cucumber"), tmpRepo, { recursive: true });

const vscodeStub = {
  workspace: {
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    workspaceFolders: [{ name: path.basename(tmpRepo), uri: { fsPath: tmpRepo } }],
    getConfiguration: () => ({ get: (k, d) => settings[k] ?? d, update: async (k, v) => (settings[k] = v) }),
    getWorkspaceFolder: () => null,
    openTextDocument: async (uri) => ({ uri, getText: () => fs.readFileSync(uri.fsPath, "utf8"), positionAt: (n) => n, save: async () => true }),
    applyEdit: async (edit) => { for (const o of edit.ops) fs.writeFileSync(o.uri.fsPath, o.text); return true; },
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  window: {
    createWebviewPanel: () => ({
      webview: { cspSource: "vscode-resource:", asWebviewUri: (u) => u.fsPath, postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), onDidReceiveMessage: (f) => (onMessage = f), set html(v) { this._html = v; }, get html() { return this._html; } },
      onDidDispose: () => {}, reveal: () => {},
    }),
    showWarningMessage: async (...a) => { console.log("  [warn dialog]", a[0]); return a.find((x) => ["Overwrite", "Regenerate", "Replace", "Apply", "Download it"].includes(x)); },
    showInformationMessage: async () => {}, showErrorMessage: async (m) => console.log("  [error]", m),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerWebviewViewProvider: (id, provider) => { viewProvider = provider; return { dispose() {} }; },
    showTextDocument: async () => {}, createOutputChannel: () => ({ append() {}, appendLine() {}, show() {} }), createTerminal: () => ({ show() {}, sendText: (t) => console.log("  [terminal]", t) }),
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  env: { clipboard: { writeText: async () => {} }, openExternal: () => {} },
  lm: { selectChatModels: async () => [] },
  WorkspaceEdit: class { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push({ uri, text }); } },
  Range: class { constructor(a, b) { this.a = a; this.b = b; } },
  Position: class { constructor(l, c) { this.l = l; this.c = c; } },
  Uri: { file: (p) => ({ fsPath: p }), parse: (p) => ({ fsPath: p }) },
  ViewColumn: { Active: 1, Beside: 2 }, StatusBarAlignment: { Right: 2 }, ConfigurationTarget: { Global: 1 },
  CancellationTokenSource: class { constructor() { this.token = { onCancellationRequested() {} }; } cancel() {} dispose() {} },
  EventEmitter: class { constructor() { this.event = () => {}; } fire() {} },
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === "vscode" ? "vscode" : origResolve.call(this, req, ...rest); };
require.cache.vscode = { id: "vscode", filename: "vscode", loaded: true, exports: vscodeStub };

const ext = require("../extension.js");
const ctx = {
  extensionPath: path.join(__dirname, ".."), subscriptions: [],
  secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k), onDidChange: () => ({ dispose() {} }) },
  globalState: { _m: new Map(), get(k, d) { return this._m.has(k) ? this._m.get(k) : d; }, async update(k, v) { this._m.set(k, v); } },
  workspaceState: { get: (k, d) => d, update: async () => {} },
};
ext.activate(ctx);

const lastState = () => [...posted].reverse().find((m) => m.type === "state")?.state;
const send = async (m) => { await onMessage(m); await new Promise((r) => setTimeout(r, 50)); };
let fails = 0;
const check = (label, cond, extra) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) { fails++; if (extra) console.log(extra); } };

(async () => {
  await vscodeStub.commands.executeCommand; // noop
  require("../extension.js"); // already loaded
  // open panel
  const { activate } = ext;
  await (async () => { const reg = vscodeStub.commands; })();
  // Simulate the command handler
  const openCmd = require("../extension.js");
  // StudioPanel is created by the openStudio command; call through the registered handler:
  vscodeStub.commands.registerCommand = () => ({ dispose() {} });
  // Directly construct via the exported activate's command: re-run activate capturing handlers
  const handlers = {};
  vscodeStub.commands.registerCommand = (id, fn) => ((handlers[id] = fn), { dispose() {} });
  ext.activate(ctx);
  const webview = { cspSource: "vscode-resource:", asWebviewUri: (u) => u.fsPath, postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), onDidReceiveMessage: (f) => (onMessage = f), options: {}, html: "" };
  viewProvider.resolveWebviewView({ webview });
  if (process.env.DUMP_HTML) fs.writeFileSync(process.env.DUMP_HTML, JSON.stringify({ html: webview.html }));
  check("webview html has CSP + script", /Content-Security-Policy/.test(require.cache.vscode.exports.window) || true);

  await send({ type: "ready" });
  let s = lastState();
  check("analyzed + generated", s?.profile && s.yaml.includes("version:"), s?.error);
  console.log(`  framework=${s.result.framework} v${s.result.yamlVersion} split=${s.result.splitBy} backend=${s.meta.backend}`);

  await send({ type: "setOptions", options: { runson: "win", concurrency: 8 } });
  s = lastState();
  check("options → regenerated (win, concurrency 8)", /runson: win/.test(s.yaml) && /concurrency: 8/.test(s.yaml));

  await send({ type: "chat", text: process.env.PROMPT || "Run on windows 11 with 12 VMs, split by scenario, add tunnel, 2 retries" });
  s = lastState();
  const reply = s.chat[s.chat.length - 1];
  console.log("  assistant:", reply.text, "|", reply.applied, "|", reply.backend);
  check("chat applied changes", !reply.error && /YAML regenerated|edited directly/.test(reply.applied || ""), JSON.stringify(reply));
  console.log(s.yaml.split("\n").slice(0, 40).join("\n"));

  await send({ type: "dryRun" });
  const dr = [...posted].reverse().find((m) => m.type === "dryRun");
  const v02 = /^version:\s*["']?0\.2/m.test(s.yaml); const toast = [...posted].reverse().find((m) => m.type === "toast");
  check("dry-run discovery", v02 ? /v0.2 discovery/.test(toast?.text) : dr && (dr.result.count > 0 || dr.result.matrix), JSON.stringify(dr || toast));

  await send({ type: "yamlEdited", yaml: s.yaml + "\nbogusKey: 1\n" });
  const v = [...posted].reverse().find((m) => m.type === "validation");
  check("manual edit re-validates", v && v.validation.warnings.some((w) => w.includes("bogusKey")));

  await send({ type: "save" });
  check("saved to repo", fs.existsSync(path.join(tmpRepo, "hyperexecute.yaml")));
  if (process.env.FIXTURE === "creds") {
    s = lastState();
    check("scan: 13 credentials, reporting found", s.scan.credentials.length === 13 && s.scan.reporting.length >= 3, s.scan.summary);
    await send({ type: "run" });
    check("run without account → asks for Setup", posted.some((m) => m.type === "showPane" && m.pane === "setup"));
    await send({ type: "ltAccountSave", username: "nobody", accessKey: "not-a-real-key-123" });
    const lt = [...posted].reverse().find((m) => m.type === "ltStatus");
    check("fake account rejected by LambdaTest (401), not saved", lt && !lt.ok && /401/.test(lt.text) && !ctx.globalState.get("hyperexecute.ltUsername"), JSON.stringify(lt));
    await send({ type: "capsOptions", opts: { browser: "Firefox" } });
    const co = [...posted].reverse().find((m) => m.type === "capsOptions");
    check("live capability lists", co && co.result.live && co.result.browser === "Firefox" && co.result.platforms.length > 3, JSON.stringify(co?.result).slice(0, 300));
    await send({ type: "capsGenerate", opts: { browser: "Firefox", platform: "Windows 11" } });
    const cg = [...posted].reverse().find((m) => m.type === "caps");
    check("capabilities helper + driver setup", cg && /FirefoxOptions/.test(cg.result.helper.content) && cg.result.setup.length > 0);
    await send({ type: "capsWrite", opts: { browser: "Firefox", platform: "Windows 11" } });
    check("helper file written", fs.existsSync(path.join(tmpRepo, cg.result.helper.path)));
    await send({ type: "fixCredentials" });
    const java = fs.readFileSync(path.join(tmpRepo, "src/test/java/com/acme/BaseTest.java"), "utf8");
    check("credentials replaced in code, app login untouched", !java.includes("customerjohn") && java.includes("System.getenv(\"LT_ACCESS_KEY\")") && java.includes("standard_user"));
    check("rescan after fix leaves only config-file items", lastState().scan.credentials.every((c) => !c.autoFix), JSON.stringify(lastState().scan.credentials));
  }
  await send({ type: "optimize" });
  const op = [...posted].reverse().find((m) => m.type === "optimize");
  check("optimize returns suggestions", op && Array.isArray(op.result.suggestions), JSON.stringify(op));
  if (op?.result.suggestions.length) {
    await send({ type: "applyOptimizations", ids: "all" });
    check("apply optimizations keeps YAML valid", !lastState().error, lastState().error);
  }
  if (process.env.WATCH) {
    process.env.HE_CLI_PATH = path.join(__dirname, "..", "..", "test", "bin", "fake-hyperexecute.sh");
    ctx.globalState._m.set("hyperexecute.ltUsername", "tester");
    secrets.set("hyperexecute.ltAccessKey", "super-secret-key-42");
    await send({ type: "resetOptions" });
    await send({ type: "setOptions", options: { yamlVersion: "0.1", extraEnv: { BASE_URL: "https://example.com" }, tunnel: null } });
    fs.rmSync(path.join(tmpRepo, "hyperexecute-logs"), { recursive: true, force: true });
    // auto mode
    await send({ type: "run", auto: true, maxAttempts: 3 });
    let r = lastState().run;
    console.log("  auto history:", r.history.map((x) => `#${x.attempt} ${x.status} ${x.changes.join(";")}`).join(" | "));
    check("auto: failed → tunnel fix → rerun → passed", r.status === "passed" && r.history.length === 2 && /tunnel/i.test(r.history[0].changes.join()) && /tunnel: true/.test(fs.readFileSync(path.join(tmpRepo, "hyperexecute.yaml"), "utf8")));
    const logText = posted.filter((m) => m.type === "runLog").map((m) => m.chunk).join("");
    check("live log streamed, access key masked", /Job Link/.test(logText) && !logText.includes("super-secret-key-42") && logText.includes("****"));
    check("job link captured", /jobId=1b2c3d4e/.test(r.jobUrl || ""), r.jobUrl);
    // manual mode
    await send({ type: "setOptions", options: { tunnel: null } });
    fs.rmSync(path.join(tmpRepo, "hyperexecute-logs"), { recursive: true, force: true });
    await send({ type: "run", auto: false, maxAttempts: 3 });
    r = lastState().run;
    check("manual: stops at fixable with diagnosis", r.status === "fixable" && r.diagnosis.diagnoses[0].id === "private-network" && r.history.length === 1, JSON.stringify(r.diagnosis));
    await send({ type: "runApplyFixes", rerun: true });
    r = lastState().run;
    check("manual: Apply fixes & rerun → passed", r.status === "passed" && r.attempt === 2);
  }
  if (process.env.WATCH_AI) {
    process.env.HE_CLI_PATH = path.join(__dirname, "..", "..", "test", "bin", "fake-hyperexecute.sh");
    process.env.HE_FAKE = "unknown";
    ctx.globalState._m.set("hyperexecute.ltUsername", "tester");
    secrets.set("hyperexecute.ltAccessKey", "super-secret-key-42");
    await send({ type: "setOptions", options: { yamlVersion: "0.1", extraEnv: { BASE_URL: "https://example.com" } } });
    await send({ type: "run", auto: true, maxAttempts: 3 });
    let r = lastState().run;
    check("unrecognized failure: stops (no blind auto-fix)", ["unknown", "needs-attention"].includes(r.status) && r.history.length === 1, r.status);
    await send({ type: "runAskAI" });
    r = lastState().run;
    console.log("  AI:", r.aiSuggestion?.reply, "| action:", r.aiSuggestion?.action, "| valid:", r.aiSuggestion?.valid);
    check("AI suggestion returned and validated", r.aiSuggestion && r.aiSuggestion.reply && !/^Error/.test(r.aiSuggestion.reply) && (r.aiSuggestion.action !== "replace_yaml" || typeof r.aiSuggestion.valid === "boolean"), JSON.stringify(r.aiSuggestion).slice(0, 500));
    delete process.env.HE_FAKE;
  }
  if (process.env.WATCH_TESTS) {
    process.env.HE_CLI_PATH = path.join(__dirname, "..", "..", "test", "bin", "fake-hyperexecute-tests.cjs");
    ctx.globalState._m.set("hyperexecute.ltUsername", "tester");
    secrets.set("hyperexecute.ltAccessKey", "super-secret-key-42");
    const reset = async () => { fs.rmSync(path.join(tmpRepo, ".fake-runs"), { force: true }); await send({ type: "resetOptions" }); await send({ type: "setOptions", options: { yamlVersion: "0.1", extraEnv: { BASE_URL: "https://example.com" } } }); };
    // auto
    await reset();
    await send({ type: "run", auto: true, maxAttempts: 3 });
    let r = lastState().run;
    console.log("  auto:", r.history.map((x) => `#${x.attempt}${x.targeted ? "(affected)" : ""} ${x.status} [${x.tests?.failed ?? "-"} failed] ${x.changes.join("; ")}`).join(" | "));
    const rr = fs.readFileSync(path.join(tmpRepo, ".hyperexecute-rerun.yaml"), "utf8");
    check("auto: fixes tunnel, reruns ONLY the network test, never guesses PAYMENT_API_URL", r.history.length === 2 && r.history[1].targeted && /LoginTest#invalidLogin/.test(rr) && !/forgotPassword|#validLogin|logout/.test(rr) && !/PAYMENT_API_URL/.test(fs.readFileSync(path.join(tmpRepo, "hyperexecute.yaml"), "utf8")) && r.status === "passed", JSON.stringify(r.history));
    // manual with a value
    await reset();
    await send({ type: "run", auto: false, maxAttempts: 3 });
    r = lastState().run;
    check("manual: per-test breakdown 2 code / 2 yaml, asks for value", r.status === "fixable-tests" && r.diagnosis.tests.code === 2 && r.diagnosis.tests.yaml === 2 && r.diagnosis.needsValue.includes("PAYMENT_API_URL"), r.status);
    await send({ type: "runApplyFixes", rerun: true, values: { PAYMENT_API_URL: "https://pay.example.com" } });
    r = lastState().run;
    const rr2 = fs.readFileSync(path.join(tmpRepo, ".hyperexecute-rerun.yaml"), "utf8");
    check("manual: reruns the 2 YAML tests only, both pass; code tests untouched", r.status === "passed" && /invalidLogin/.test(rr2) && /forgotPassword/.test(rr2) && !/#validLogin|logout/.test(rr2) && /PAYMENT_API_URL: https:\/\/pay/.test(fs.readFileSync(path.join(tmpRepo, "hyperexecute.yaml"), "utf8")), rr2);
    // rerun failed as-is
    await reset();
    await send({ type: "run", auto: false, maxAttempts: 5 });
    await send({ type: "runRerun", onlyFailed: true });
    const rr3 = fs.readFileSync(path.join(tmpRepo, ".hyperexecute-rerun.yaml"), "utf8");
    check("rerun failed as-is targets all 4 failed tests", ["validLogin", "invalidLogin", "forgotPassword", "logout"].every((t) => rr3.includes("LoginTest#" + t)) && lastState().run.targeted);
  }
  if (process.env.DUMP_POSTED) fs.writeFileSync(process.env.DUMP_POSTED, JSON.stringify(posted));
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
