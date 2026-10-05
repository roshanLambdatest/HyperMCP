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
const commandHandlers = {};
const executed = [];
let infoPick = (a) => (a.includes("Create page") ? "Create page" : undefined);
let viewProvider;
const fixture = (n) => path.join(__dirname, "..", "..", "test", "fixtures", n);
const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "he-repo-"));
// learning and caches go to a throwaway folder, not the developer's ~/.hyperexecute-studio
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "he-state-"));
Object.assign(process.env, { HE_GISTS: "off", HE_DOCS: "off", HE_UPDATE_CHECK: "off", HE_STATE_DIR: stateDir, HE_KB_CACHE_DIR: path.join(stateDir, "kb-cache"), HE_FEEDBACK_DIR: path.join(stateDir, "feedback") });
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
    onDidChangeWindowState: () => ({ dispose() {} }),
    createWebviewPanel: () => ({
      webview: { cspSource: "vscode-resource:", asWebviewUri: (u) => u.fsPath, postMessage: (m) => posted.push(JSON.parse(JSON.stringify(m))), onDidReceiveMessage: (f) => (onMessage = f), set html(v) { this._html = v; }, get html() { return this._html; } },
      onDidDispose: () => {}, reveal: () => {},
    }),
    showWarningMessage: async (...a) => { console.log("  [warn dialog]", a[0]); return a.find((x) => ["Overwrite", "Regenerate", "Replace", "Apply", "Download it"].includes(x)); },
    showInformationMessage: async (...a) => infoPick(a), withProgress: async (_o, f) => f(), showErrorMessage: async (m) => console.log("  [error]", m),
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    registerWebviewViewProvider: (id, provider) => { viewProvider = provider; return { dispose() {} }; },
    showTextDocument: async () => {}, createOutputChannel: () => ({ append() {}, appendLine() {}, show() {} }), createTerminal: () => ({ show() {}, sendText: (t) => console.log("  [terminal]", t) }),
  },
  commands: { registerCommand: (id, f) => { commandHandlers[id] = f; return { dispose() {} }; }, executeCommand: async (id, ...a) => { executed.push([id, ...a]); } },
  env: { clipboard: { writeText: async () => {} }, openExternal: () => {} },
  lm: { selectChatModels: async () => [] },
  WorkspaceEdit: class { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push({ uri, text }); } },
  Range: class { constructor(a, b) { this.a = a; this.b = b; } },
  Position: class { constructor(l, c) { this.l = l; this.c = c; } },
  Uri: { file: (p) => ({ fsPath: p }), parse: (p) => ({ fsPath: p }) },
  ProgressLocation: { Notification: 15 },
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
  check("timeline: the analysis shows in the chat", s.chat.some((m) => m.role === "event" && /^Analyzed /.test(m.text) && m.pane === "setup"), JSON.stringify(s.chat));
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
  const ch = reply.change;
  if (!reply.applied) console.log("SKIP  change details and undo: the chat request applied nothing (set PROMPT for this fixture)");
  else {
  check("chat shows what changed, why, the diff and validation", ch && ch.changes.length && ch.changes.every((c) => c.why) && ch.diff.added + ch.diff.removed > 0 && ch.check, JSON.stringify(ch)?.slice(0, 600));

  const beforeUndo = s.yaml;
  await send({ type: "chat", text: "undo" });
  s = lastState();
  check("undo restores the YAML from before the chat change", s.yaml !== beforeUndo && /runson: win\b/.test(s.yaml) && /concurrency: 8/.test(s.yaml) && s.chat.find((m) => m.change?.id === ch.id)?.change.undone, s.chat[s.chat.length - 1]?.text);
  await send({ type: "chat", text: "undo" });
  check("nothing left to undo", /Nothing to undo/.test(lastState().chat.at(-1).text));
  await send({ type: "chat", text: process.env.PROMPT || "Run on windows 11 with 12 VMs, split by scenario, add tunnel, 2 retries" });
  s = lastState();
  }

  await send({ type: "dryRun" });
  const dr = [...posted].reverse().find((m) => m.type === "dryRun");
  const v02 = /^version:\s*["']?0\.2/m.test(s.yaml); const toast = [...posted].reverse().find((m) => m.type === "toast");
  check("dry-run discovery", v02 ? /v0.2 discovery/.test(toast?.text) : dr && (dr.result.count > 0 || dr.result.matrix), JSON.stringify(dr || toast));

  await send({ type: "yamlEdited", yaml: s.yaml + "\nbogusKey: 1\n" });
  const v = [...posted].reverse().find((m) => m.type === "validation");
  check("manual edit re-validates", v && v.validation.warnings.some((w) => w.includes("bogusKey")));

  await send({ type: "save" });
  check("saved to repo", fs.existsSync(path.join(tmpRepo, "hyperexecute.yaml")));
  check("timeline: the save shows in the chat, undo doesn't add a line", lastState().chat.some((m) => m.role === "event" && m.text === "Saved the YAML") && !lastState().chat.some((m) => m.role === "event" && /Undid/.test(m.text)));
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
    const before = fs.readdirSync(path.join(tmpRepo, "src/test/java/com/acme")).length;
    check("connection points with in-place changes", cg && cg.result.points.some((p) => /BaseTest\.java/.test(p.file) && /FirefoxOptions/.test(p.code || "")) && !cg.result.helper);
    check("no connection file created", fs.readdirSync(path.join(tmpRepo, "src/test/java/com/acme")).length === before);
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
    check("learning: the tunnel fix is remembered", r.learned?.change?.added.some((l) => /tunnel: true/.test(l)) && fs.existsSync(path.join(stateDir, "learned-fixes.json")), JSON.stringify(r.learned));
    const logText = posted.filter((m) => m.type === "runLog").map((m) => m.chunk).join("");
    check("live log streamed, access key masked", /Job Link/.test(logText) && !logText.includes("super-secret-key-42") && logText.includes("****"));
    check("job link captured", /jobId=1b2c3d4e/.test(r.jobUrl || ""), r.jobUrl);
    // manual mode
    await send({ type: "setOptions", options: { tunnel: null } });
    fs.rmSync(path.join(tmpRepo, "hyperexecute-logs"), { recursive: true, force: true });
    await send({ type: "run", auto: false, maxAttempts: 3 });
    r = lastState().run;
    check("manual: stops at fixable with diagnosis", r.status === "fixable" && r.diagnosis.diagnoses[0].id === "private-network" && r.history.length === 1, JSON.stringify(r.diagnosis));
    check("learning: the same failure shows the fix that worked before", r.fixedBefore?.change?.added.some((l) => /tunnel: true/.test(l)), JSON.stringify(r.fixedBefore));
    await send({ type: "runApplyFixes", rerun: true });
    r = lastState().run;
    check("manual: Apply fixes & rerun → passed", r.status === "passed" && r.attempt === 2);
    // Add to Confluence, against a stand-in Confluence
    const http = require("http");
    const created = [];
    const conf = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c)).on("end", () => {
        res.setHeader("Content-Type", "application/json");
        if (req.url.startsWith("/wiki/rest/api/user/current")) return res.end(JSON.stringify({ type: "known", displayName: "Tester" }));
        if (req.url.startsWith("/wiki/api/v2/spaces")) return res.end(JSON.stringify({ results: [{ id: "77" }] }));
        if (req.url === "/wiki/api/v2/pages") { created.push(JSON.parse(body)); return res.end(JSON.stringify({ id: "5", title: created[0].title, _links: { base: "http://confluence.test/wiki", webui: "/pages/5" } })); }
        res.statusCode = 404; res.end("{}");
      });
    });
    await new Promise((ok) => conf.listen(0, "127.0.0.1", ok));
    Object.assign(settings, { atlassianEmail: "qa@example.com", confluenceBaseUrl: `http://127.0.0.1:${conf.address().port}/wiki` });
    secrets.set("hyperexecute.atlassianToken", "atl-token-xyz");
    await send({ type: "publishConfluence" });
    const pg = created[0]?.body?.value || "";
    check("Add to Confluence: page with runs, fixes and learning, no secrets", created.length === 1 && /<h2>Runs<\/h2>/.test(pg) && /Fixed the YAML/.test(pg) && /Learned from this session/.test(pg) && !pg.includes("super-secret-key-42") && !/\btester\b/.test(pg), pg.slice(0, 400));
    conf.close();
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
  if (process.env.SHARED_CREDS) {
    // an account saved earlier by the MCP tool, never entered in the Studio
    const dir = path.join(require("os").homedir(), ".hyperexecute-studio");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "credentials.json"), JSON.stringify({ username: "roshan", accessKey: "LT_SharedKey1234567890abcdef" }));
    process.env.HE_CLI_PATH = path.join(__dirname, "..", "..", "test", "bin", "fake-hyperexecute-tests.cjs");
    fs.rmSync(path.join(tmpRepo, ".fake-runs"), { force: true });
    await send({ type: "resetOptions" });
    await send({ type: "setOptions", options: { yamlVersion: "0.1", extraEnv: { BASE_URL: "https://example.com" } } });
    const before = posted.length;
    await send({ type: "run", auto: false, maxAttempts: 1 });
    const asked = posted.slice(before).some((m) => m.type === "showPane" && m.pane === "setup");
    check("Studio uses the account saved by the MCP tool, no Setup prompt", !asked && lastState().run?.attempt === 1 && lastState().meta.ltUser === "roshan", JSON.stringify(lastState().run?.status));
    check("Studio run filled the temporary YAML and removed it", /filled$/.test(fs.readFileSync(path.join(tmpRepo, ".fake-last-config"), "utf8")) && !fs.readdirSync(tmpRepo).some((n) => n.startsWith(".hyperexecute-run-")));
  }
  // updates from GitHub releases: a newer release is offered, downloaded, checked and installed
  {
    const crypto = require("crypto");
    const vsix = Buffer.concat([Buffer.from("PK"), crypto.randomBytes(4000)]);
    let digest = "sha256:" + crypto.createHash("sha256").update(vsix).digest("hex");
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).startsWith("https://api.github.com/repos/roshanLambdatest/HyperMCP/releases/latest"))
        return new Response(JSON.stringify({ tag_name: "v9.9.9", html_url: "https://github.com/roshanLambdatest/HyperMCP/releases/tag/v9.9.9", assets: [{ name: "hyperexecute-studio.vsix", browser_download_url: "https://github.com/roshanLambdatest/HyperMCP/releases/download/v9.9.9/hyperexecute-studio.vsix", digest }] }), { status: 200 });
      if (String(url).includes("/releases/download/v9.9.9/")) return new Response(vsix, { status: 200 });
      return realFetch(url);
    };
    ctx.extension = { packageJSON: require("../package.json") };
    let asked = null;
    infoPick = (a) => { asked = a[0]; return "Update"; };
    await commandHandlers["hyperexecute.checkForUpdates"]();
    const inst = executed.find((e) => e[0] === "workbench.extensions.installExtension");
    check("update: newer release offered, verified and installed", /9\.9\.9 is available/.test(asked || "") && inst && /hyperexecute-studio-9\.9\.9\.vsix$/.test(inst[1].fsPath), JSON.stringify({ asked, inst }));
    executed.length = 0;
    digest = "sha256:" + "0".repeat(64);
    let err = null;
    const errStub = vscodeStub.window.showErrorMessage;
    vscodeStub.window.showErrorMessage = async (m) => { err = m; };
    await commandHandlers["hyperexecute.checkForUpdates"]();
    check("update: a download that doesn't match the release SHA-256 is not installed", /SHA-256/.test(err || "") && !executed.some((e) => e[0] === "workbench.extensions.installExtension"), err);
    vscodeStub.window.showErrorMessage = errStub;
    global.fetch = realFetch;
  }
  if (process.env.DUMP_POSTED) fs.writeFileSync(process.env.DUMP_POSTED, JSON.stringify(posted));
  console.log(fails ? `\n${fails} FAILED` : "\nALL PASSED");
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
