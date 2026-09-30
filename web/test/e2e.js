// End-to-end test of the built site (web/dist) in real Chrome:
//   - sample repos are zipped and uploaded like a customer would; the YAML must equal the Node core's
//   - the chat: option changes, undo, env values, explain, optimize, pasted-log diagnosis, fallback
//   - Claude (optional): the request the page sends is checked and answered with a canned response
//   - checks, security scan, diagnose tab, grid (live LambdaTest API), samples, phone layout, CSP, network
//   node test/e2e.js [--shots]   (--shots saves screenshots to test/shots/)

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { zipSync } = require("fflate");
const puppeteer = require("puppeteer-core");

const here = __dirname;
const dist = path.join(here, "..", "dist");
const fixtures = path.join(here, "..", "..", "test", "fixtures");
const shots = process.argv.includes("--shots") ? path.join(here, "shots") : null;
const chrome = process.env.CHROME_PATH || ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => fs.existsSync(p));

let failures = 0;
const check = (label, cond, detail) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) { failures++; if (detail !== undefined) console.log(String(detail).slice(0, 1500)); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function zipFixture(name) {
  const files = {};
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else files[`${name}/${r}`] = fs.readFileSync(path.join(dir, e.name)); // one top folder, like GitHub's Download ZIP
    }
  })(path.join(fixtures, name), "");
  const out = path.join(os.tmpdir(), `he-web-${name}.zip`);
  fs.writeFileSync(out, zipSync(files));
  return out;
}
const stripHeader = (y) => y.split("\n").filter((l) => !l.startsWith("#") && l !== "---").join("\n").trim();

(async () => {
  if (!chrome) { console.log("SKIP  no Chrome found (set CHROME_PATH)"); return; }
  if (!fs.existsSync(path.join(dist, "index.html"))) throw new Error("Build first: npm run build");
  process.env.HE_EMBED_CREDENTIALS = "off"; // no saved account may leak into the Node side of the parity check
  const { analyzeRepo } = await import("../../src/analyzer.js");
  const { generateYaml } = await import("../../src/generator.js");

  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
  const server = http.createServer((req, res) => {
    const rel = new URL(req.url, "http://x").pathname;
    const file = path.join(dist, rel === "/" ? "index.html" : rel);
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  }).listen(0);
  const url = `http://127.0.0.1:${server.address().port}/`;

  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

  // Anthropic API: answer with a canned plan and record what the page sent (no real key or call needed)
  const anthropic = [];
  await page.setRequestInterception(true);
  page.on("request", (r) => {
    const u = r.url();
    if (!u.startsWith("https://api.anthropic.com/")) return r.continue();
    const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
    if (r.method() === "OPTIONS") return r.respond({ status: 204, headers: cors });
    anthropic.push({ url: u, headers: r.headers(), body: r.postData() ? JSON.parse(r.postData()) : null });
    if (u.includes("/v1/models/")) return r.respond({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ id: "claude-opus-5-5", type: "model", display_name: "Claude Opus 5.5" }) });
    const plan = { reply: "Set 7 VMs, as asked.", action: "update_options", options: { yamlVersion: null, runson: null, runsonMatrix: null, executionMode: null, splitBy: null, concurrency: 7, retryOnFailure: null, maxRetries: null, globalTimeout: null, matrixValues: null, extraMatrix: null, extraEnv: null, extraPre: null, tunnel: null, mavenProfile: null }, yaml: null };
    r.respond({ status: 200, headers: cors, contentType: "application/json", body: JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: JSON.stringify(plan) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } }) });
  });
  const requests = [];
  page.on("request", (r) => requests.push(r.url()));

  await page.goto(url, { waitUntil: "networkidle0" });
  check("landing renders", await page.$eval("h1", (h) => h.textContent.includes("Your test repo")));
  if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, "1-landing.png") }); }

  const yaml = () => page.$eval("#yaml", (t) => t.value);
  const load = async (name) => {
    if (await page.$("#newRepo:not(.hidden)")) { await page.click("#newRepo"); await page.waitForSelector("#pickZip"); }
    await (await page.$("#pickZip")).uploadFile(zipFixture(name));
    await page.waitForSelector("#yaml", { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector("#yaml").value.length > 50);
    return yaml();
  };
  const tab = async (id) => { await page.click(`.tab[data-tab="${id}"]`); return page.$eval("#panel", (p) => p.innerText); };
  const lastBot = () => page.$$eval("#msgs .msg.bot .body", (b) => b.at(-1)?.innerText || "");
  const ask = async (text, untilChanged = true) => {
    const before = await page.$$eval("#msgs .msg", (m) => m.length);
    await page.$eval("#input", (t, v) => { t.value = v; }, text);
    await page.click("#send");
    if (untilChanged) await page.waitForFunction((n) => document.querySelectorAll("#msgs .msg.bot").length && document.querySelectorAll("#msgs .msg").length >= n + 2 && !document.querySelector(".typing"), { timeout: 15000 }, before);
    return lastBot();
  };

  // ---------- parity with the Node core ----------
  for (const name of ["maven-testng", "maven-cucumber", "playwright-projects", "node-monorepo", "pyproject-only", "gradle-kts", "dotnet-nunit", "maven-profiles"]) {
    const web = await load(name);
    const node = generateYaml(analyzeRepo(path.join(fixtures, name)), { outputFileName: "hyperexecute.yaml", embedCredentials: false }).yaml;
    check(`${name}: browser YAML == Node YAML`, stripHeader(web) === stripHeader(node), `--- browser\n${web}\n--- node\n${node}`);
    check(`${name}: welcome message names the repo`, (await lastBot()).includes(name), await lastBot());
  }

  // maven-profiles: the question becomes a chip; the option bar has the profile
  const wel = await lastBot();
  check("welcome: asks about the Maven profile, with chips", /Maven profile/.test(wel) && /Use profile smoke/.test(wel), wel);
  await page.select("#o-mvnp", "smoke");
  await page.waitForFunction(() => document.querySelector("#yaml").value.includes("-Psmoke"));
  check("option bar: Maven profile → -Psmoke", true);

  // ---------- chat ----------
  await load("maven-testng");
  let r = await ask("Run on Windows 11 with 10 VMs and add a tunnel");
  let y = await yaml();
  check("chat: 'Windows 11, 10 VMs, tunnel' changes the YAML", /runson: win11/.test(y) && /concurrency: 10/.test(y) && /tunnel: true/.test(y) && /Windows 11/.test(r), r);
  check("chat: unfilled value explained as a to-do with a chip", /Almost ready/.test(r) && /Set BASE_URL/.test(r), r);
  r = await ask("undo");
  check("chat: undo", /runson: linux/.test(await yaml()) && /Undone/.test(r), r);
  r = await ask("BASE_URL=https://staging.example.com");
  y = await yaml();
  check("chat: env value fills the placeholder → valid", /BASE_URL: https:\/\/staging.example.com/.test(y) && /The YAML is valid/.test(r) && (await page.$eval("#statusPill", (e) => e.innerText)).includes("Valid"), r);
  r = await ask("split by method");
  check("chat: split by method (v0.2 discoveryType)", /discoveryType: method/.test(await yaml()), r);
  r = await ask("Run it on Chrome and Firefox");
  y = await yaml();
  check("chat: browsers → matrix axis in v0.1", /browser:\s*\n\s*- chrome\s*\n\s*- firefox/.test(y) && /version: 0.1/.test(y), y.slice(0, 900));
  r = await ask("Explain this YAML");
  check("chat: explain", /YAML v0.1/.test(r) && /Matrix/.test(r), r);
  r = await ask("what is a tunnel?");
  check("chat: FAQ answer", /tunnel: true/.test(r), r);
  r = await ask("Optimize it");
  check("chat: optimize", /improvement|Nothing to optimize/.test(r), r);
  r = await ask("reset");
  check("chat: reset to defaults", /version: "0.2"/.test(await yaml()), r);
  r = await ask("org.openqa.selenium.WebDriverException: unknown error: net::ERR_NAME_NOT_RESOLVED (https://staging.acme.internal)\n  at com.acme.LoginTest.open(LoginTest.java:21)\nJob failed");
  check("chat: pasted log → diagnosis with a fix", /fixable/i.test(r) && /Use the corrected YAML/.test(r), r);
  await page.evaluate(() => [...document.querySelectorAll("#msgs .chip")].find((c) => c.textContent.includes("Use the corrected YAML")).click());
  await wait(300);
  check("chat: corrected YAML applied", /tunnel: true/.test(await yaml()));
  r = await ask("please make it purple and dance");
  check("chat: unknown request → helpful fallback + Claude hint", /didn't catch that/.test(r) && /Claude/.test(r), r);
  if (shots) await page.screenshot({ path: path.join(shots, "2-workspace.png") });

  // ---------- Claude (optional, visitor's own key) ----------
  await page.click("#settingsBtn");
  await page.type("#aiKey", "sk-ant-test-key");
  await page.click("#aiCheck");
  await page.waitForFunction(() => /Key works|rejected|reach/.test(document.querySelector("#aiState").textContent));
  check("settings: key check calls the Models API", /Key works/.test(await page.$eval("#aiState", (e) => e.textContent)));
  await page.click("#dlgClose");
  r = await ask("I want exactly seven machines please");
  const req = anthropic.find((a) => a.url.includes("/v1/messages"));
  check("claude: request goes to the Messages API with the visitor's key", req && req.headers["x-api-key"] === "sk-ant-test-key", JSON.stringify(req?.headers));
  check("claude: browser access header + fallback beta", req && req.headers["anthropic-dangerous-direct-browser-access"] === "true" && /server-side-fallback-2026-07-01/.test(req.headers["anthropic-beta"] || ""), JSON.stringify(req?.headers));
  check("claude: model, fallbacks, JSON-schema output", req && req.body.model === "claude-opus-5-5" && req.body.fallbacks === "default" && req.body.output_config?.format?.type === "json_schema" && req.body.output_config.effort === "low", JSON.stringify(req?.body)?.slice(0, 600));
  check("claude: no source files sent (summary + YAML only)", req && !JSON.stringify(req.body).includes("public class LoginTest"), "source leaked");
  check("claude: its plan is applied (7 VMs) and labelled", /concurrency: 7/.test(await yaml()) && /via Claude/.test(r), r);

  // ---------- drawer tabs ----------
  await load("maven-testng");
  await page.$eval("#yaml", (t) => { t.value = t.value.replace(/runson: linux/, "runson: ubuntu"); t.dispatchEvent(new Event("input")); });
  await wait(600);
  let text = await tab("checks");
  check("checks: editing re-validates (bad runson)", /runson "ubuntu" is invalid/.test(text) && (await page.$eval("#edited", (e) => e.textContent)) === "Edited", text);
  text = await tab("diagnose");
  await page.type("#logs", "Tests run: 5, Failures: 2\njava.lang.AssertionError: expected [x] but found [y]");
  await page.click("#diagGo");
  check("diagnose tab: assertion failures → not a YAML problem", /not a YAML problem/.test(await page.$eval("#diagOut", (e) => e.innerText)));
  text = await tab("run");
  check("run tab: CLI + commands", /Download the HyperExecute CLI/.test(text) && /--config hyperexecute.yaml/.test(text), text);
  await load("creds");
  text = await tab("security");
  check("security: 13 credentials, masked, visitor wording", /13 hard-coded LambdaTest credentials/.test(text) && !text.includes("abcdefghijklmnop") && !/customer/i.test(text), text.slice(0, 400));
  text = await tab("grid");
  await page.waitForSelector("#capDl", { timeout: 20000 });
  text = await page.$eval("#panel", (p) => p.innerText);
  check("grid: live lists from LambdaTest + helper code", /live from LambdaTest/.test(text) && /LT:Options/.test(await page.$eval("#panel pre", (p) => p.textContent)), text.slice(0, 300));

  // ---------- samples ----------
  await page.click("#newRepo");
  await page.waitForSelector('[data-sample="web-e2e"]');
  await page.click('[data-sample="web-e2e"]');
  await page.waitForSelector("#yaml");
  check("sample repo loads (Playwright)", /npx playwright test/.test(await yaml()) && /web-e2e/.test(await lastBot()));

  // ---------- phone ----------
  await page.setViewport({ width: 390, height: 844 });
  await wait(300);
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("phone: workspace fits (no sideways scroll)", overflow <= 1, `${overflow}px`);
  await page.click('#views [data-v="yaml"]');
  check("phone: view switcher shows the YAML", await page.$eval(".editor-card", (e) => e.offsetParent !== null) && await page.$eval(".chat", (e) => e.offsetParent === null));
  if (shots) await page.screenshot({ path: path.join(shots, "3-phone-yaml.png") });
  await page.click('#views [data-v="chat"]');
  if (shots) await page.screenshot({ path: path.join(shots, "4-phone-chat.png") });
  await page.click("#newRepo");
  await wait(200);
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("phone: landing fits", overflow <= 1, `${overflow}px`);

  const external = requests.filter((u) => !u.startsWith(url));
  check("network: only LambdaTest and (opt-in) Anthropic", external.every((u) => /^https:\/\/api\.(lambdatest|anthropic)\.com\//.test(u)), external.join("\n"));
  check("no page errors or CSP violations", !errors.length, errors.join("\n"));

  await browser.close();
  server.close();
  console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
