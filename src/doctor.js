// Diagnoses a finished HyperExecute run from its CLI output and downloaded logs, and turns known
// failure patterns into YAML changes. Genuine test failures are reported, never "fixed" by rerunning.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { toSelector, testLabel, collectTestResults, parseResultFile } from "./results.js";
import { cleanLine, isNoise } from "./loglines.js";

function dedupeTests(tests) {
  const m = new Map();
  for (const t of tests) {
    const k = t.format === "cucumber" ? `${t.uri}:${t.line}` : `${t.classname}|${t.name}`;
    const prev = m.get(k);
    if (!prev || prev.status !== "passed") m.set(k, t);
  }
  return [...m.values()];
}

const MAX_LOG_BYTES = 4 * 1024 * 1024;

// ---------- collecting evidence ----------

// Stage logs come down as logs/<jobId>/tasks/<taskId>/<stage> — no file extension.
const STAGE_LOG = /(?:^|\/)logs\/[^/]+\/tasks\/([^/]+)\/([^/.]+)(?:\.log)?$/;
const stageKind = (s) => (/^pre/i.test(s || "") ? "pre" : /^post/i.test(s || "") ? "post" : String(s || "").toLowerCase());

// The CLI's own debug log (hyperexecute-cli.log) is appended to on every run and is full of transfer
// chatter ("1 Done, 0 Failed, 0 Pending"). Keep only this run's user-facing messages.
function cliLogMessages(text, since) {
  const out = [];
  for (const line of text.split("\n")) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || j.level === "debug" || typeof j.msg !== "string") continue;
    if (since && Date.parse(j.time) < since - 2000) continue;
    out.push(j.msg.trimEnd());
  }
  return out.join("\n");
}

// Which stage stopped the job. Sources, best first: the job summary the CLI writes (.hyperexecute/result.json),
// then the CLI's stage lines ("x [1]  pre (2s)", "Failed pre stage percentage: 100.00%").
// Returns {stage, taskId, remark, step, command, log, file} or null. `log` is the failing command's output.
export function findFailedStage({ output = "", files = [], job }) {
  let hit = null;
  for (const t of job?.tasks || []) {
    const s = (t.stages || []).find((x) => /fail|error/i.test(x.status || ""));
    if (s) { hit = { stage: stageKind(s.type || s.name), taskId: t.id || null, remark: t.remark || job.remark || null }; break; }
  }
  if (!hit) {
    const m = output.match(/(?:^|[\n"])\s*[x✘✗×]\s+\[\d+\]\s+(pre|post)\w*\s+\(/i) || output.match(/Failed (pre|post) stage percentage:\s+(?!0+(?:\.0+)?%)[\d.]+%/i);
    if (!m) return null;
    hit = { stage: stageKind(m[1]), taskId: (output.match(/taskId:\s*([\w-]+) has failed/) || [])[1] || null, remark: null };
  }
  hit.remark = hit.remark || (output.match(/has failed with remark:\s*([^\n"\\]+)/) || [])[1]?.trim() || null;
  hit.step = +(String(hit.remark || "").match(/\bstep (\d+)\b/i) || [])[1] || null;
  const logs = files.filter((f) => f.stage && stageKind(f.stage) === hit.stage);
  const f = logs.find((x) => x.taskId === hit.taskId) || logs[0];
  hit.file = f?.file || null;
  hit.command = null;
  hit.log = null;
  if (f) {
    // each command's output starts with "******* <command> *******"; the job stops at the one that failed
    const heads = [...f.text.matchAll(/^\*{5,} (.+?) \*{5,}[ \t]*$/gm)];
    const last = heads[heads.length - 1];
    hit.command = last ? last[1].trim() : null;
    hit.log = (last ? f.text.slice(last.index + last[0].length) : f.text).trim().slice(-8000);
  }
  return hit;
}

// Reads CLI output plus any log/report files the CLI downloaded during this run.
export function collectEvidence({ output = "", repoPath, since, artifactsDir }) {
  const files = [];
  const resultFiles = [];
  let job = null;
  if (repoPath && since) {
    const root = path.resolve(repoPath);
    const stack = [root];
    let budget = MAX_LOG_BYTES;
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!/^(node_modules|\.git|target|build|dist|\.gradle|venv|\.venv|m2_cache_dir|gradle_cache|pip_cache|nuget_cache)$/.test(e.name)) stack.push(full);
          continue;
        }
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (st.mtimeMs < since) continue;
        if (/\.(xml|json|trx)$/i.test(e.name)) resultFiles.push(full);
        const rel = path.relative(root, full).split(path.sep).join("/");
        const stage = rel.match(STAGE_LOG);
        if ((!stage && !/\.(log|txt|json|xml|html?)$/i.test(e.name)) || st.size > 2 * 1024 * 1024 || budget <= 0) continue;
        if (/^src\/|\/src\//.test(rel) || rel === "hyperexecute.yaml") continue;
        let text = fs.readFileSync(full, "utf8").slice(0, budget);
        if (e.name === "hyperexecute-cli.log") text = cliLogMessages(text, since);
        if (/\.json$/i.test(e.name) && /"stages"\s*:/.test(text)) { try { const j = JSON.parse(text); if (Array.isArray(j.tasks)) job = j; } catch {} }
        budget -= text.length;
        files.push({ file: rel, text: e.name.endsWith(".html") ? text.replace(/<[^>]+>/g, " ") : text, stage: stage ? stage[2] : null, taskId: stage ? stage[1] : null });
      }
    }
  }
  const all = [output, ...files.map((f) => `\n===== ${f.file} =====\n${f.text}`)].join("\n");
  // Per-test results from the downloaded artifacts plus any report written into the repo during the run.
  const tests = collectTestResults([artifactsDir]);
  for (const f of resultFiles) for (const t of parseResultFile(f)) tests.push(t);
  return {
    text: all,
    tests: dedupeTests(tests),
    files: files.map((f) => f.file),
    failedStage: findFailedStage({ output: all, files, job }),
    scenarios: scenarioCounts(job),
    jobId: (all.match(/jobId[=:"\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || all.match(/job[ _-]?id\W+([\w-]{8,})/i) || [])[1] || null,
    jobUrl: (all.match(/https:\/\/[\w.-]*(?:hyperexecute|lambdatest|testmuai)[\w.-]*\/[^\s"')]*job[^\s"')]*/i) || [])[0] || null,
  };
}

// Totals from the runners' printed summaries, across every downloaded scenario log
export function runnerSummary(text) {
  let passed = 0, failed = 0;
  for (const m of text.matchAll(/^\s*(\d+) passing\b/gm)) passed += +m[1];
  for (const m of text.matchAll(/^\s*(\d+) failing\b/gm)) failed += +m[1];
  for (const m of text.matchAll(/^Tests:\s+(?:(\d+) failed, )?(?:\d+ skipped, )?(?:(\d+) passed, )?(\d+) total/gm)) { failed += +(m[1] || 0); passed += +(m[2] || 0); }
  for (const m of text.matchAll(/^(\d+) tests?, (\d+) passed, (\d+) failed/gm)) { passed += +m[2]; failed += +m[3]; }
  for (const m of text.matchAll(/│\s*Passing:\s+(\d+)\s*│[\s\S]{0,200}?│\s*Failing:\s+(\d+)/g)) { passed += +m[1]; failed += +m[2]; }
  return { passed, failed, total: passed + failed };
}

// How the job's test scenarios ended, from the CLI's job summary: { completed, failed, skipped, … }
function scenarioCounts(job) {
  if (!job) return null;
  const c = {};
  for (const t of job.tasks || []) for (const s of t.stages || []) if (/scenario/i.test(s.type || "")) c[s.status || "unknown"] = (c[s.status || "unknown"] || 0) + 1;
  return Object.keys(c).length ? c : null;
}

// ---------- rules ----------

const excerpt = (text, re, radius = 1) => {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return "";
  return lines.slice(Math.max(0, i - radius), i + radius + 1).join("\n").slice(0, 600);
};

// pre commands live in `pre` or in `preDirectives.commands`
const preCommands = (js) => js.preDirectives?.commands || js.pre || [];
const rewritePre = (fn) => (d) => {
  for (const p of [["pre"], ["preDirectives", "commands"]]) {
    const cur = d.getIn(p)?.toJSON?.();
    if (Array.isArray(cur)) d.setIn(p, cur.map((c) => (typeof c === "string" ? fn(c) : c)));
  }
};
const setNode = (version) => (d) => d.set("runtime", { language: "node", version: String(version) });

// Rules for a job that stopped in the pre step. They only see the failed command's own log, and they run
// before the general rules. A pre failure means no test ran, so it is never a "test failure".
const PRE_RULES = [
  {
    id: "npm-peer-deps", category: "dependencies",
    re: /npm ERR! code ERESOLVE|ERESOLVE (could not|unable to) resolve/i,
    title: "npm refused to install: peer dependency conflict (ERESOLVE)",
    why: "npm 7+ stops when two packages want different versions of a peer dependency; the log names the conflict and suggests --legacy-peer-deps.",
    fix: (ctx) => {
      const hit = preCommands(ctx.js).find((c) => /\bnpm (ci|install|i)\b/.test(c) && !/--legacy-peer-deps|--force/.test(c));
      if (!hit) return null;
      return { patch: rewritePre((c) => (/--legacy-peer-deps|--force/.test(c) ? c : c.replace(/\bnpm (ci|install|i)\b/, "npm $1 --legacy-peer-deps"))), summary: `Added --legacy-peer-deps to "${hit}" in pre` };
    },
    advice: "Or fix the conflict in package.json so a plain install works.",
  },
  {
    id: "npm-too-old", category: "environment",
    re: /Usage: npm <command>[\s\S]{0,3000}?npm@([0-4]\.\d+|5\.[0-6])\.\d+/,
    title: "The VM's npm is too old for `npm ci`",
    why: "The Node version on the VM ships an npm that doesn't know `npm ci`, so npm printed its usage text and exited.",
    fix: (ctx) => {
      if (ctx.js.runtime?.language === "node" && parseInt(ctx.js.runtime.version, 10) >= 10) return null;
      const want = parseInt(ctx.profile?.runtimeVersion, 10) >= 10 ? parseInt(ctx.profile.runtimeVersion, 10) : 18;
      return { patch: setNode(want), summary: `Set runtime: node ${want}` };
    },
    advice: "Pin a current Node version with runtime: {language: node, version: ...}.",
  },
  {
    id: "npm-lock-sync", category: "dependencies",
    re: /can only install packages when your package\.json and (package-lock\.json|npm-shrinkwrap\.json)[^\n]*in sync|can only install with an existing package-lock\.json|Missing: [^\n]+ from lock file/i,
    title: "package-lock.json is missing or out of sync, so `npm ci` refused to run",
    why: "`npm ci` needs a lock file that matches package.json exactly.",
    fix: (ctx) => (preCommands(ctx.js).some((c) => /\bnpm ci\b/.test(c)) ? { patch: rewritePre((c) => c.replace(/\bnpm ci\b/, "npm install")), summary: "Replaced npm ci with npm install in pre" } : null),
    advice: "Better: run npm install locally and commit the updated package-lock.json.",
  },
  {
    id: "node-engine", category: "environment",
    re: /npm ERR! code EBADENGINE|The engine "node" is incompatible with this module/i,
    title: "A package needs a different Node version than the VM has",
    why: "The install stopped on an engines check.",
    fix: (ctx) => {
      const range = (ctx.text.match(/Expected version "([^"]+)"/) || ctx.text.match(/[Rr]equired:\s*\{[^}]*node:\s*'([^']+)'/) || [])[1];
      const majors = (range || "").match(/\d+(?=\.|\b)/g)?.map(Number).filter((n) => n >= 8 && n <= 30) || [];
      if (!majors.length) return null;
      const want = Math.max(...majors);
      return String(ctx.js.runtime?.version || "").split(".")[0] === String(want) ? null : { patch: setNode(want), summary: `Set runtime: node ${want} (package requires ${range})` };
    },
  },
  {
    id: "pre-wrong-directory", category: "paths",
    re: /Could not open requirements file|npm ERR! (enoent|code ENOENT)[\s\S]{0,400}package\.json|there is no POM in this directory|does not contain a Gradle build|MSB1003|MSB1009/i,
    title: "The pre command ran in a folder that doesn't have the project file",
    why: "pre runs from the repo root, but the project file (package.json, pom.xml, requirements.txt…) wasn't found there.",
    fix: (ctx) => {
      const root = ctx.profile?.projectRoot || ctx.profile?.installRoot || ctx.profile?.packageRoot;
      const cmd = ctx.pre.command;
      if (!root || !cmd || /^\s*cd\s/.test(cmd)) return null;
      return { patch: rewritePre((c) => (c.trim() === cmd ? `cd ${root} && ${c}` : c)), summary: `Run "${cmd}" from ${root}/` };
    },
    advice: "Check the file name and path in the pre command against the repo.",
  },
  {
    id: "pre-command-not-found", category: "environment",
    re: /^(?:.*?: )?(?:line \d+: )?(?!(?:mvn|gradle|node|npm|npx|python3?|pip3?|dotnet|java):)([\w./-]+): (?:command )?not found\s*$|'([^'\n]+)' is not recognized as an internal or external command/m,
    title: "The pre step calls a program that isn't on the VM",
    why: "A command in pre (or a script it runs) isn't installed on the HyperExecute VM.",
    advice: "Install it earlier in pre, commit the script to the repo, or drop the command.",
  },
  {
    id: "pre-compile", category: "code",
    re: /COMPILATION ERROR|cannot find symbol|error CS\d{4}|error TS\d{4}/,
    title: "The project doesn't compile in the pre step",
    why: "The build in pre failed on a compile error, so no test ran.",
    advice: "If it compiles on your machine, the VM is probably on a different language version — pin it with runtime. Otherwise fix the code.",
  },
];

// fix kinds: {options: {...}} → regenerate with generator options · {patch(doc, js)} → edit YAML in place · none → advice only
const RULES = [
  {
    id: "cli-auth", category: "account", stop: true,
    re: /Invalid user\/key credentials|ERR::NO::USER|Unable to find LT username/i,
    title: "HyperExecute rejected the LambdaTest credentials",
    why: "The CLI couldn't authenticate, so no job was created.",
    advice: "Check the account in Setup (Save & test).",
  },
  {
    id: "zero-tests", category: "discovery",
    re: /(no tests? (were )?(found|discovered)|discovered 0 tests|0 tests? discovered|test discovery (returned|found) (0|no|nothing)|Total items discovered: 0|empty discovery)/i,
    title: "Test discovery found no tests",
    why: "The discovery step returned nothing, so nothing ran.",
    fix: (ctx) => {
      const v = String(ctx.js.version);
      if (v === "0.2" && ctx.js.testDiscovery) return { patch: (d) => d.delete("testDiscovery"), summary: "Removed the testDiscovery block that sends v0.2 jobs down the v0.1 path" };
      if (v !== "0.2" && ctx.v02) return { options: { yamlVersion: "0.2" }, summary: "Switched to YAML v0.2 so HyperExecute discovers tests itself" };
      if (ctx.js.testDiscovery?.mode === "remote") return { patch: (d) => d.setIn(["testDiscovery", "mode"], "local"), summary: "Run discovery locally (mode: local)" };
      return null;
    },
  },
  {
    id: "tool-missing", category: "environment",
    re: /\b(mvn|gradle|node|npm|npx|python3?|pip3?|dotnet|java)(: command not found|: not found| is not recognized as an internal or external command)/i,
    title: "A build tool is missing on the VM",
    why: "The runtime the commands need isn't installed on the VM image.",
    fix: (ctx) => {
      const tool = (ctx.text.match(/\b(mvn|gradle|node|npm|npx|python3?|pip3?|dotnet|java)(?=: command not found|: not found| is not recognized)/i) || [])[1] || "";
      const lang = /mvn|gradle|java/.test(tool) ? "java" : /node|npm|npx/.test(tool) ? "node" : /python|pip/.test(tool) ? "python" : /dotnet/.test(tool) ? "dotnet" : null;
      if (!lang) return null;
      const version = ctx.profile?.language === { node: "node", python: "python", java: "java", dotnet: "csharp" }[lang] && ctx.profile.runtimeVersion ? String(ctx.profile.runtimeVersion) : { java: "17", node: "20", python: "3.11", dotnet: "8.0" }[lang];
      return { patch: (d) => d.set("runtime", { language: lang, version }), summary: `Added runtime: ${lang} ${version}` };
    },
  },
  {
    id: "java-version", category: "environment",
    re: /(invalid target release|release version \d+ not supported|UnsupportedClassVersionError|class file version \d+|has been compiled by a more recent version of the Java Runtime)/i,
    title: "Wrong Java version on the VM",
    why: "The code targets a newer Java than the VM uses.",
    fix: (ctx) => {
      const m = ctx.text.match(/invalid target release:?\s*(\d+)|release version (\d+) not supported/i);
      const classVer = ctx.text.match(/class file version (\d+)/i);
      const v = (m && (m[1] || m[2])) || (classVer ? String(+classVer[1] - 44) : null) || ctx.profile?.runtimeVersion || "17";
      return { patch: (d) => d.set("runtime", { language: "java", version: String(v) }), summary: `Pinned runtime: java ${v}` };
    },
  },
  {
    id: "permission-wrapper", category: "environment",
    re: /\.\/(mvnw|gradlew|hyperexecute)[^\n]*Permission denied|Permission denied[^\n]*(mvnw|gradlew)/i,
    title: "Build wrapper isn't executable",
    why: "./mvnw or ./gradlew lost its executable bit (common when the repo is zipped on Windows).",
    fix: (ctx) => {
      const w = /gradlew/.test(ctx.text) ? "gradlew" : "mvnw";
      return { patch: (d) => { const pre = (d.get("pre")?.toJSON?.() || []); if (!pre.some((c) => c.includes(`chmod +x ${w}`))) d.set("pre", [`chmod +x ${w}`, ...pre]); }, summary: `Added chmod +x ${w} to pre` };
    },
  },
  {
    id: "private-network", category: "network",
    re: /\bUnknownHostException\b|\bENOTFOUND\b|getaddrinfo EAI_AGAIN|\bERR_NAME_NOT_RESOLVED\b|[Cc]ould not resolve host|\bERR_CONNECTION_REFUSED\b|\bECONNREFUSED\b|\bERR_CONNECTION_TIMED_OUT\b|net::ERR_ADDRESS_UNREACHABLE|[Nn]ame or service not known/,
    title: "Tests can't reach the application (private network)",
    why: "The app or a dependency host isn't reachable from HyperExecute VMs — typical for staging/internal URLs.",
    fix: (ctx) => (ctx.js.tunnel ? null : { patch: (d) => d.set("tunnel", true), summary: "Enabled tunnel: true" }),
    advice: "If a tunnel is already on, check the tunnel is running and the host is reachable from your network.",
  },
  {
    id: "timeout", category: "timeouts",
    re: /(global timeout|globalTimeout|testSuiteTimeout|test suite timeout|exceeded the (maximum|allowed) (time|duration)|timed out after \d+ ?m(in)?|killed due to (idle|inactivity)|idle inactivity)/i,
    title: "The job or a task hit a timeout",
    why: "A stage ran longer than the YAML allows.",
    fix: (ctx) => {
      const idle = /idle|inactivity/i.test(ctx.text);
      const g = Math.min(150, Math.max(ctx.js.globalTimeout || 90, 120));
      return {
        patch: (d) => {
          if (idle) d.set("idleTimeout", 900);
          d.set("globalTimeout", g);
          d.set("testSuiteTimeout", Math.min(g, Math.max(ctx.js.testSuiteTimeout || 90, 120)));
          d.set("testSuiteStep", Math.min(g, Math.max(ctx.js.testSuiteStep || 90, 120)));
        },
        summary: idle ? "Raised idleTimeout to 900s and the stage timeouts" : `Raised globalTimeout/testSuiteTimeout to ${g} min`,
      };
    },
  },
  {
    id: "crlf-script", category: "setup",
    re: /(\/usr\/bin\/env: .?(sh|bash|python3?)\\r.?: No such file or directory|bad interpreter: [^\n]*\^M|\$'\\r': command not found)/,
    title: "A script has Windows line endings",
    why: "A wrapper or shell script was committed with CRLF line endings, so Linux/macOS can't start it.",
    fix: (ctx) => {
      const pre = preCommands(ctx.js);
      const script = ["gradlew", "mvnw"].find((w) => JSON.stringify(ctx.js).includes(`./${w}`));
      if (!script || pre.some((c) => typeof c === "string" && c.includes("\\r$"))) return null;
      return { patch: (d) => d.set("pre", [`sed -i.bak 's/\\r$//' ${script}`, ...pre]), summary: `Stripped Windows line endings from ${script} in pre` };
    },
  },
  {
    id: "node-module-missing", category: "dependencies",
    re: /Cannot find module '([^'./][^']*)'/,
    title: "A Node module the tests load isn't installed",
    why: "A config, plugin or test requires a package that package.json doesn't list, so npm install never brings it onto the VM.",
    fix: (ctx) => {
      const raw = (ctx.text.match(/Cannot find module '([^'./][^']*)'/) || [])[1];
      if (!raw) return null;
      const mod = raw.startsWith("@") ? raw.split("/").slice(0, 2).join("/") : raw.split("/")[0];
      const pre = preCommands(ctx.js);
      if (pre.some((c) => typeof c === "string" && c.includes(mod))) return null;
      return { patch: (d) => d.set("pre", [...pre, `npm install --no-save ${mod}`]), summary: `Added npm install --no-save ${mod} to pre` };
    },
  },
  {
    id: "playwright-browsers", category: "environment",
    re: /(Executable doesn't exist at .*ms-playwright|browserType\.launch: Executable doesn't exist|Please run the following command to download new browsers)/i, // not the bare words: our own pre runs "playwright install"
    title: "Playwright browsers aren't installed",
    why: "The Playwright package is there but its browsers were never downloaded on the VM.",
    fix: (ctx) => {
      const pre = ctx.js.pre || [];
      if (pre.some((c) => /playwright install/.test(c))) return null;
      const cmd = ctx.profile?.language === "python" ? "python3 -m playwright install" : "npx playwright install";
      return { patch: (d) => d.set("pre", [...pre, cmd]), summary: `Added ${cmd} to pre` };
    },
  },
  {
    id: "local-driver", category: "environment",
    re: /(SessionNotCreatedException|cannot find (Chrome|Firefox) binary|chromedriver[^\n]*(not found|only supports Chrome version)|This version of ChromeDriver only supports|WebDriverException: .*unknown error: cannot find)/i,
    title: "Local browser/driver problem on the VM",
    why: "Tests start a local browser whose driver doesn't match the VM's browser.",
    advice: "Use the Grid tab's helper to run on the LambdaTest grid, or use Selenium Manager / WebDriverManager instead of a pinned driver.",
  },
  {
    id: "grid-auth", category: "credentials",
    re: /(hub\.lambdatest\.com|cdp\.lambdatest\.com)[^\n]*(401|Unauthorized)|Unauthorized[^\n]*lambdatest|\b(LT_USERNAME|LT_ACCESS_KEY|user ?name|access ?key)\b\s*(is|was|=|:)\s*['"]?(null|undefined|empty)['"]?\s*($|[,;.)])|Invalid username or access ?key/im,
    title: "Tests can't log in to the LambdaTest grid",
    why: "LT_USERNAME / LT_ACCESS_KEY aren't reaching the tests on the VM.",
    fix: (ctx) => {
      const env = ctx.js.env || {};
      if (env.LT_USERNAME && env.LT_ACCESS_KEY) return null;
      return {
        patch: (d) => { d.setIn(["env", "LT_USERNAME"], "${{ .secrets.LT_USERNAME }}"); d.setIn(["env", "LT_ACCESS_KEY"], "${{ .secrets.LT_ACCESS_KEY }}"); },
        summary: "Mapped LT_USERNAME / LT_ACCESS_KEY from HyperExecute secrets",
      };
    },
    advice: "Runs fill LT_USERNAME / LT_ACCESS_KEY from your saved account. If this persists, check the account in Setup (Save & test) and that the tests read those variables.",
  },
  {
    id: "no-tests-executed", category: "discovery",
    re: /(No tests were executed|No tests to run|No tests matching pattern|No tests found for given includes|Tests run: 0, Failures: 0|No test sources found|no tests ran|collected 0 items|No specs found|No test files found)/i,
    title: "Tasks ran but executed no tests",
    why: "The runner command's selector doesn't match what discovery produced (e.g. wrong class/method format or a runner that ignores the flag).",
    fix: (ctx) => {
      if (ctx.v02 && String(ctx.js.version) !== "0.2") return { options: { yamlVersion: "0.2" }, summary: "Switched to YAML v0.2 (native runner builds the selector)" };
      if (/#/.test(ctx.js.testRunnerCommand || "") || /while read f/.test(ctx.js.testDiscovery?.command || "")) return { options: { splitBy: "class" }, summary: "Switched to class-level splitting" };
      return null;
    },
  },
  {
    id: "cucumber-features", category: "discovery",
    re: /(No features found at|Feature path .* does not exist|features? (file|path)[^\n]*not (found|exist))/i,
    title: "Cucumber can't find the feature files",
    why: "The feature paths passed to Cucumber don't resolve from the directory the runner runs in.",
    advice: "Check the project folder (commands may need to cd into it) and the features path in the runner options.",
  },
  {
    id: "oom", category: "resources",
    re: /(java\.lang\.OutOfMemoryError|Java heap space|GC overhead limit exceeded|JavaScript heap out of memory|ENOMEM|Killed\s+(mvn|node|java|python))/i,
    title: "Out of memory on the VM",
    why: "The build or tests exceeded the default heap.",
    fix: (ctx) => {
      const node = /JavaScript heap/.test(ctx.text);
      return { patch: (d) => (node ? d.setIn(["env", "NODE_OPTIONS"], "--max-old-space-size=4096") : d.setIn(["env", "MAVEN_OPTS"], "-Xmx3g")), summary: node ? "Set NODE_OPTIONS=--max-old-space-size=4096" : "Set MAVEN_OPTS=-Xmx3g" };
    },
  },
  {
    id: "dependency-download", category: "dependencies",
    re: /(Could not resolve dependencies|Could not transfer artifact|Failed to read artifact descriptor|npm ERR! (code (E404|E401|E403|E5\d\d|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EINTEGRITY)|network)|ERR_PNPM_FETCH|No matching distribution found|Could not find a version that satisfies|Unable to load the service index|NU1301)/i,
    title: "Dependencies failed to download",
    why: "The pre step couldn't fetch dependencies — a flaky registry, or a private registry the VM can't reach.",
    fix: (ctx) => {
      const privateRepo = /(nexus|artifactory|jfrog|\.internal|\.corp|\.local|10\.\d+\.\d+\.\d+|192\.168\.)/i.test(ctx.text);
      if (privateRepo && !ctx.js.tunnel) return { patch: (d) => d.set("tunnel", true), summary: "Enabled tunnel: true (private registry)" };
      return { patch: (d) => { d.set("preDirectives", { commands: ctx.js.pre || [], maxRetries: 2 }); d.delete("pre"); }, summary: "Retry the pre step up to 2 times (preDirectives.maxRetries)" };
    },
  },
  {
    id: "windows-bash", category: "environment",
    re: /('(grep|sed|awk|find)' is not recognized|The term '(grep|sed|awk)' is not recognized|FIND: Parameter format not correct)/i,
    title: "bash discovery on a Windows VM",
    why: "grep/sed/awk aren't available on the Windows VM.",
    fix: (ctx) => (ctx.js.testDiscovery ? { patch: (d) => d.setIn(["testDiscovery", "mode"], "local"), summary: "Run discovery locally (mode: local)" } : null),
  },
  {
    id: "concurrency-limit", category: "account",
    re: /(concurrency limit|exceeds (your|the) (plan|allowed) concurrency|max(imum)? concurrency (reached|exceeded)|not enough (licen[cs]es|slots))/i,
    title: "Concurrency is higher than the account allows",
    why: "The job asked for more parallel VMs than the plan permits, so it queued or failed.",
    fix: (ctx) => {
      const lim = +(ctx.text.match(/concurrency[^\d\n]{0,40}(\d{1,3})/i) || [])[1];
      const next = lim && lim < (ctx.js.concurrency || 99) ? lim : Math.max(1, Math.floor((ctx.js.concurrency || 2) / 2));
      return { patch: (d) => d.set("concurrency", next), summary: `Lowered concurrency to ${next}` };
    },
  },
  {
    id: "report-missing", category: "reports",
    re: /(partial report[^\n]*(not found|missing|no such)|report location[^\n]*(not found|does not exist)|no files? (were )?found (for|at|matching) [^\n]*report)/i,
    title: "Report files weren't where the YAML expects",
    why: "partialReports/uploadArtefacts point at a folder the framework didn't write.",
    advice: "Check the report output folder of the framework and update partialReports.location.",
  },
  {
    id: "test-failures", category: "tests", stop: true, notYaml: true,
    re: /(AssertionError|AssertionFailedError|expected:? ?<[^>]*> but was|Tests run: \d+, Failures: [1-9]|\b[1-9]\d* failed(,| \()|FAILED \(failures=|Error: expect\(|✘|NoSuchElementException|ElementNotInteractableException|TimeoutException: .*waiting for)/i,
    title: "Tests failed on assertions / element lookups",
    why: "The run worked; the tests themselves failed. That's an application or test issue, not the YAML.",
    advice: "Open the failing tests in the HyperExecute dashboard. Rerunning won't fix these — retryOnFailure already covers flaky ones.",
  },
];

// ---------- diagnosis ----------

export function diagnose({ evidence, yamlText, profile, exitCode, v02Name }) {
  const doc = YAML.parseDocument(yamlText || "");
  const js = doc.toJS() || {};
  const tests = evidence.tests || [];
  // A job that stopped in the pre step never reached the tests: judge it by the pre log, not by test patterns.
  const pre = evidence.failedStage?.stage === "pre" ? { ...evidence.failedStage } : null;
  if (pre && !pre.command && pre.step) pre.command = preCommands(js)[pre.step - 1] || null;
  const ranTests = tests.length > 0 || /(?:Pass|Failed) test stage percentage:\s+(?!0+(?:\.0+)?%)[\d.]+%/i.test(evidence.text || "");
  const text = pre?.log || evidence.text || "";
  // switching to v0.2 is only a fix where its native discovery worked in real jobs (.NET); for Java it
  // found 0 tests in every real run
  const ctx = { text, js, profile, v02: Boolean(v02Name && /^dotnet\//.test(v02Name)), pre };
  const found = [];
  for (const r of [...(pre ? PRE_RULES : []), ...RULES]) {
    if (!r.re.test(text) || (pre && !ranTests && r.notYaml)) continue;
    let fix = null;
    try { fix = r.fix ? r.fix(ctx) : null; } catch { fix = null; }
    found.push({ id: r.id, category: r.category, title: r.title, why: r.why, advice: r.advice || null, evidence: excerpt(text, r.re), fix, stop: !!r.stop, notYaml: !!r.notYaml });
  }
  if (pre && !found.length) {
    found.push({
      id: "pre-step-failed", category: "setup", title: `The pre step failed${pre.command ? `: ${pre.command}` : ""}${pre.remark ? ` (${pre.remark})` : ""}`,
      why: "The job stopped while setting up the VM, before any test ran — a YAML/environment problem, not a test failure.",
      advice: pre.log ? "Read failedStage.log, change the pre command (or the runtime/env it needs) in the YAML, then rerun." : "The pre log wasn't downloaded — open the pre stage of the task in the HyperExecute dashboard, or pass the logs folder.",
      evidence: pre.log ? pre.log.split("\n").slice(-8).join("\n").slice(-600) : "", fix: null, stop: false, notYaml: false,
    });
  }
  // Per-test classification when the job produced reports.
  const classified = tests.length ? classifyTests(tests, { yamlText, profile }) : [];
  if (tests.length) {
    const i = found.findIndex((f) => f.id === "test-failures");
    if (i >= 0) found.splice(i, 1); // real per-test data beats the log regex
  }
  const testFixes = [];
  for (const c of classified) if (c.fix && !testFixes.some((f) => f.key === c.fix.key)) testFixes.push(c.fix);
  const yamlTests = classified.filter((c) => c.cause === "yaml" && c.fix);
  const affected = yamlTests.map((c) => ({ c, sel: toSelector(c.test, profile, js) })).filter((x) => x.sel);
  const yamlFixes = found.filter((f) => f.fix);
  const failed = classified.length;
  const needsValue = [...new Set(yamlTests.map((c) => c.fix.needsValue).filter(Boolean))];
  // test runners' own summaries in the logs (Cypress/Mocha "N passing / M failing", Jest "Tests: …",
  // Robot "N tests, P passed, F failed"), for runs that ran tests but left no report file
  const sum = runnerSummary(evidence.text || "");
  // the job summary says how the scenarios ended, even when no per-test report was downloaded
  const sc = evidence.scenarios || {};
  const scDone = sc.completed || 0, scFailed = (sc.failed || 0) + (sc.error || 0), scSkipped = sc.skipped || 0;
  if (!pre && !scDone && !scFailed && scSkipped && !found.some((f) => f.id === "zero-tests")) {
    found.push({ id: "scenarios-skipped", category: "discovery", title: "Every scenario was skipped: no test ran", why: "The runner command ran but executed no test (wrong selector, a runner class outside the test sources, a suite file that needs a -D property), and HyperExecute marked each scenario skipped.", advice: "Run the runner command locally for one discovered item and check it runs tests; compare with the repo's own test command.", evidence: "", fix: null, stop: false, notYaml: false });
  }
  // per-test reports beat stage statuses: every reported test passed = passed
  const allTestsPassed = tests.length > 0 && tests.every((t) => t.status === "passed" || t.status === "skipped") && tests.some((t) => t.status === "passed");
  const logVerdict = !pre && !yamlFixes.length && !tests.length && sum.total
    ? sum.failed ? (sum.passed ? "passed-with-failures" : "test-failures") : "passed"
    : null;
  if (logVerdict && sum.failed && !found.some((f) => f.id === "test-failures")) found.push({ id: "test-failures", category: "tests", title: "Tests failed on assertions / element lookups", why: `The run worked: ${sum.passed} passed, ${sum.failed} failed (from the test runner's summary). That's the tests or the application, not the YAML.`, advice: "Open the failing tests in the HyperExecute dashboard; rerunning won't fix them.", evidence: "", fix: null, stop: true, notYaml: true });
  const scenarioVerdict = logVerdict ? logVerdict : pre || yamlFixes.length || failed ? null
    // a scenario the grid marked failed counts even when the framework's report passed (tests that catch
    // errors and set the session status themselves)
    : scFailed && (scDone || allTestsPassed) ? "passed-with-failures"
    : allTestsPassed || (scDone && !scSkipped) ? "passed" : null;
  const status =
    found.some((f) => f.id === "cli-auth") ? "auth-error" :
    scenarioVerdict && !found.some((f) => !f.notYaml) ? scenarioVerdict :
    yamlFixes.length ? "fixable" :
    yamlTests.length && yamlTests.every((c) => c.fix.needsValue) ? "needs-input" :
    yamlTests.length ? "fixable-tests" :
    failed && classified.every((c) => c.cause === "code") ? "test-failures" :
    failed ? "needs-attention" :
    exitCode === 0 && !found.some((f) => f.id !== "test-failures") ? (found.length ? "passed-with-failures" : "passed") :
    found.some((f) => f.notYaml) ? "test-failures" :
    found.length ? "needs-attention" : "unknown";
  return {
    status,
    scenarios: evidence.scenarios || undefined,
    jobId: evidence.jobId,
    jobUrl: evidence.jobUrl,
    failedStage: pre ? { stage: "pre", step: pre.step, command: pre.command, remark: pre.remark, logFile: pre.file, log: pre.log ? pre.log.slice(-3000) : null } : null,
    diagnoses: found.map(({ fix, ...f }) => ({ ...f, fixSummary: fix?.summary || null, fixType: fix ? (fix.options ? "regenerate" : "patch") : null })),
    canAutoFix: (yamlFixes.length > 0 || yamlTests.some((c) => !c.fix.needsValue)) && !found.some((f) => f.stop && !f.notYaml),
    tests: {
      total: tests.length,
      passed: tests.filter((t) => t.status === "passed").length,
      failed,
      code: classified.filter((c) => c.cause === "code").length,
      yaml: classified.filter((c) => c.cause === "yaml").length,
      unknown: classified.filter((c) => c.cause === "unknown").length,
      list: classified.map((c) => ({ label: testLabel(c.test), selector: toSelector(c.test, profile, js)?.selector || null, cause: c.cause, rule: c.rule, reason: c.reason, fix: c.fix?.summary || null, fixKey: c.fix?.key || null, needsValue: c.fix?.needsValue || null, note: c.note, evidence: c.evidence })),
    },
    needsValue,
    rerunSelectors: affected.map((x) => x.sel.selector),
    rerunLevels: affected.map((x) => x.sel.level),
    fullRerunNeeded: yamlFixes.length > 0 || (yamlTests.length > 0 && affected.length < yamlTests.length),
    _fixes: [...yamlFixes.map((f) => ({ id: f.id, ...f.fix })), ...testFixes.map((f) => ({ id: f.key, ...f }))],
  };
}

// Applies the YAML fixes from a diagnosis. Returns {yaml, options, applied}; `options` are generator
// options to regenerate with (the caller regenerates, then re-applies patches).
export function applyDiagnosisFixes(yamlText, diagnosis, ids, values = {}) {
  const doc = YAML.parseDocument(yamlText);
  const options = {};
  const applied = [];
  for (const f of diagnosis._fixes.filter((x) => !ids || ids.includes(x.id))) {
    if (f.needsValue && !values[f.needsValue]) continue; // never invent a value
    if (f.options) Object.assign(options, f.options);
    if (f.patch) f.patch(doc, f.needsValue ? values : doc.toJS());
    applied.push(f.needsValue ? "Set env " + f.needsValue : f.summary);
  }
  return { yaml: doc.toString({ lineWidth: 0 }), options, applied };
}

// Compact log excerpt for the AI when no rule matched: the failed stage's own log first (when known),
// then error-looking lines plus the tail. Takes the evidence object or plain text.
export function logDigest(src, max = 6000) {
  const ev = typeof src === "string" ? { text: src } : src || {};
  const st = ev.failedStage;
  const head = st?.log ? `----- failed ${st.stage} step${st.command ? `: ${st.command}` : ""}${st.file ? ` (${st.file})` : ""} -----\n${st.log.slice(-Math.floor(max * 0.6))}\n` : "";
  // error lines leave out the noise headline() skips (cache misses, download progress, summary JSON); the tail keeps it
  const lines = (ev.text || "").split("\n").map(cleanLine).filter(Boolean);
  const errs = lines.filter((l) => !isNoise(l) && /\b(error|exception|failed|failure|fatal|denied|not found|timed? ?out|refused|ERR::)\b/i.test(l)).slice(-60);
  const tail = lines.slice(-60);
  return head + [...new Set([...errs, "----- tail -----", ...tail])].join("\n").slice(-(max - head.length));
}

export const describeDiagnosis = ({ _fixes, ...d }) => d;

// ======================= per-test classification =======================
// Each failed test is classified as a code problem (leave it), a YAML/environment problem (fix the YAML
// and rerun just that test), or unknown. Order matters: environment signals win over generic ones.

const SECRET_LIKE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|USERNAME|CREDENTIAL|AUTH)/i;

const TEST_RULES = [
  { id: "network", cause: "yaml", re: /\bUnknownHostException\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bERR_NAME_NOT_RESOLVED\b|\bECONNREFUSED\b|\bERR_CONNECTION_REFUSED\b|\bERR_CONNECTION_TIMED_OUT\b|\bERR_ADDRESS_UNREACHABLE\b|[Cc]ould not resolve host|[Nn]ame or service not known|[Cc]onnection refused/,
    reason: "The app/host isn't reachable from the HyperExecute VM (private or staging network).",
    fix: (ctx) => (ctx.js.tunnel ? { none: "tunnel is already on — check the tunnel is running and can reach the host" } : { key: "tunnel", summary: "Enable tunnel: true", patch: (d) => d.set("tunnel", true) }) },
  { id: "grid-auth", cause: "yaml", re: /(hub|cdp)\.lambdatest\.com[^\n]*(401|Unauthorized)|Unauthorized[^\n]*lambdatest|Invalid (LambdaTest )?username or access ?key/i,
    reason: "The test couldn't log in to the LambdaTest grid — LT_USERNAME / LT_ACCESS_KEY aren't reaching it.",
    fix: (ctx) => (ctx.js.env?.LT_USERNAME && ctx.js.env?.LT_ACCESS_KEY ? { none: "The YAML already maps them and runs fill in your saved account — check the account in Setup (Save & test), or that the test reads LT_USERNAME / LT_ACCESS_KEY" } : { key: "lt-secrets", summary: "Map LT_USERNAME / LT_ACCESS_KEY from HyperExecute secrets", patch: (d) => { d.setIn(["env", "LT_USERNAME"], "${{ .secrets.LT_USERNAME }}"); d.setIn(["env", "LT_ACCESS_KEY"], "${{ .secrets.LT_ACCESS_KEY }}"); } }) },
  { id: "grid-capacity", cause: "yaml", re: /queue timeout|too many (concurrent )?(sessions|requests)|concurrency limit|exceeded (the )?(allowed )?parallel/i,
    reason: "The grid rejected the session because too many ran at once.",
    fix: (ctx) => { const n = Math.max(1, Math.floor((ctx.js.concurrency || 2) / 2)); return { key: "concurrency", summary: `Lower concurrency to ${n}`, patch: (d) => d.set("concurrency", n) }; } },
  { id: "env-missing", cause: "yaml",
    re: /environment variable[ "'`]*(\w+)[ "'`]*(is )?(not set|missing|undefined|required)|Missing (required )?env(ironment)? var(iable)?[:\s"'`]+(\w+)|KeyError: '(\w+)'[\s\S]{0,400}(os\.environ|getenv)|os\.environ\[['"](\w+)['"]\][\s\S]{0,200}KeyError|process\.env\.(\w+)[^\n]*(undefined|null)|System\.getenv\("(\w+)"\)[^\n]*null|because the return value of "java\.lang\.System\.getenv\(String\)" is null/i,
    reason: "The test reads an environment variable the job doesn't provide.",
    fix: (ctx, t, m) => {
      const text = `${t.message}\n${t.detail}`;
      let name = m.slice(1).find((g) => g && /^[A-Z][A-Z0-9_]{2,}$/.test(g));
      if (!name) { const g = text.match(/getenv\("(\w+)"\)|process\.env\.(\w+)|os\.environ(?:\.get)?\(?\[?['"](\w+)['"]/); name = g && (g[1] || g[2] || g[3]); }
      if (!name) name = ctx.placeholders[0];
      if (!name) return { none: "Couldn't tell which variable — check the test's environment lookups" };
      return envFix(ctx, name);
    } },
  { id: "url-missing", cause: "yaml", re: /MalformedURLException: no protocol: (null|undefined|$)|Cannot navigate to invalid URL|invalid URL[^\n]*(null|undefined)|page\.goto: (url: expected string|Protocol error .*Cannot navigate to invalid URL)|TypeError: Invalid URL[\s\S]{0,80}(undefined|null)/i,
    reason: "The test opened an empty/undefined URL — usually a base-URL environment variable that the job doesn't set.",
    fix: (ctx) => { const name = ctx.placeholders.find((v) => /URL|HOST|ENDPOINT|DOMAIN/i.test(v)) || ctx.envVars.find((v) => /URL|HOST/i.test(v) && !(ctx.js.env || {})[v]); return name ? envFix(ctx, name) : { none: "Set the base URL the tests expect in env" }; } },
  { id: "browsers", cause: "yaml", re: /Executable doesn't exist at .*ms-playwright|browserType\.launch: Executable doesn't exist|please run the following command to download new browsers/i,
    reason: "Playwright's browsers aren't installed on the VM.",
    fix: (ctx) => { const cmd = ctx.profile?.language === "python" ? "python3 -m playwright install" : "npx playwright install"; return (ctx.js.pre || []).some((c) => /playwright install/.test(c)) ? { none: "playwright install already runs in pre" } : { key: "pw-install", summary: `Add ${cmd} to pre`, pre: cmd, patch: (d) => d.set("pre", [...(d.toJS().pre || []), cmd]) }; } },
  { id: "oom", cause: "yaml", re: /OutOfMemoryError|Java heap space|GC overhead limit|JavaScript heap out of memory|ENOMEM/i,
    reason: "The VM ran out of memory while running this test.",
    fix: (ctx, t) => (/JavaScript heap/.test(`${t.message}${t.detail}`) ? { key: "node-mem", summary: "Set NODE_OPTIONS=--max-old-space-size=4096", patch: (d) => d.setIn(["env", "NODE_OPTIONS"], "--max-old-space-size=4096") } : { key: "java-mem", summary: "Set MAVEN_OPTS=-Xmx3g", patch: (d) => d.setIn(["env", "MAVEN_OPTS"], "-Xmx3g") }) },
  { id: "py-module", cause: "yaml", re: /ModuleNotFoundError: No module named '([\w.]+)'/,
    reason: "A Python package the test imports isn't installed on the VM.",
    fix: (ctx, t, m) => {
      const mod = m[1].split(".")[0];
      if (ctx.profile?.repoPath && (fs.existsSync(path.join(ctx.profile.repoPath, mod)) || fs.existsSync(path.join(ctx.profile.repoPath, mod + ".py")))) return { none: `${mod} is a local module — check PYTHONPATH / imports` };
      const cmd = `pip3 install ${mod} --cache-dir pip_cache`;
      return { key: `pip-${mod}`, summary: `Add "${cmd}" to pre (and add ${mod} to requirements.txt)`, pre: cmd, patch: (d) => d.set("pre", [...(d.toJS().pre || []), cmd]) };
    } },
  { id: "session", cause: "yaml", re: /SessionNotCreatedException|Could not start a new session|Unable to create (a )?new (remote )?session|cannot find (Chrome|Firefox) binary|This version of ChromeDriver only supports/i,
    reason: "The browser session couldn't start (driver/browser mismatch or unsupported capability).",
    fix: () => ({ none: "Check the browser/version/platform capabilities (Grid tab) or driver setup" }) },
  // ---- code problems: leave them alone ----
  { id: "assertion", cause: "code", re: /AssertionError|AssertionFailedError|ComparisonFailure|expected:? ?\[?<?[^\n]*?>?\]? but (was|found)|expect\(.*\)\.(to|not)|Expected: .*\n\s*Received|assert .* ==|\bAssert\.(That|AreEqual|IsTrue)|should (equal|be|have)|Expected condition failed/i,
    reason: "An assertion failed — the app behaved differently than the test expects." },
  { id: "locator", cause: "code", re: /NoSuchElementException|Unable to locate element|ElementNotInteractableException|ElementClickInterceptedException|StaleElementReferenceException|waiting for (locator|selector)|locator\.\w+: Timeout|strict mode violation|no such element/i,
    reason: "An element lookup failed — a locator/page change or a timing issue in the test." },
  { id: "undefined-step", cause: "code", re: /undefined-step|is undefined|You can implement missing steps|Undefined step/i,
    reason: "A Cucumber step has no step definition." },
  { id: "local-path", cause: "code", re: /(FileNotFoundException|ENOENT|No such file or directory)[^\n]*([A-Za-z]:\\|\/Users\/|\/home\/(?!ltuser))/i,
    reason: "The test uses a path from someone's machine — make it relative to the repo." },
  { id: "compile", cause: "code", re: /cannot find symbol|COMPILATION ERROR|SyntaxError|IndentationError|error CS\d{4}|TS\d{4}:/i,
    reason: "The test code doesn't compile." },
  { id: "runtime-error", cause: "code", re: /NullPointerException|TypeError|AttributeError|ReferenceError|IndexOutOfBounds|ArgumentException|InvalidOperationException/i,
    reason: "The test code threw an error." },
];

function envFix(ctx, name) {
  const env = ctx.js.env || {};
  const cur = env[name];
  if (cur && !String(cur).startsWith("<set ")) return { none: `${name} is set in the YAML (${String(cur).includes("secrets") ? "from a secret — check the secret exists" : "check its value"})` };
  if (SECRET_LIKE.test(name)) return { key: `env-${name}`, summary: `Map ${name} from HyperExecute secret ${name}`, patch: (d) => d.setIn(["env", name], `\${{ .secrets.${name} }}`) };
  return { key: `env-${name}`, summary: `Set env ${name}`, needsValue: name, patch: (d, values) => values?.[name] && d.setIn(["env", name], values[name]) };
}

export function classifyTests(tests, { yamlText, profile }) {
  const js = YAML.parse(yamlText || "") || {};
  const envVars = profile?.envVars || [];
  const ctx = { js, profile, envVars, placeholders: Object.entries(js.env || {}).filter(([, v]) => String(v).startsWith("<set ")).map(([k]) => k) };
  return tests.filter((t) => t.status === "failed").map((t) => {
    const text = `${t.kind === "undefined-step" ? "undefined-step\n" : ""}${t.message}\n${t.detail}`;
    for (const r of TEST_RULES) {
      const m = text.match(r.re);
      if (!m) continue;
      const fx = r.fix ? r.fix(ctx, t, m) : null;
      return { test: t, cause: r.cause, rule: r.id, reason: r.reason, fix: fx && !fx.none ? fx : null, note: fx?.none || null, evidence: (t.message || t.detail.split("\n")[0] || "").slice(0, 300) };
    }
    return { test: t, cause: "unknown", rule: null, reason: "Not a pattern I recognize.", fix: null, note: null, evidence: (t.message || t.detail.split("\n")[0] || "").slice(0, 300) };
  });
}

// Rerun only the given tests: keeps the fixed YAML's settings, restricts discovery to the selectors.
export function buildTargetedRerun({ fixedYaml, selectors, profile, generate }) {
  const doc = YAML.parseDocument(fixedYaml);
  const js = doc.toJS() || {};
  const list = [...new Set(selectors)];
  const win = process.platform === "win32";
  const discovery = win ? list.map((s) => `echo ${s}`).join("&& ") : `printf '%s\\n' ${list.map((s) => `'${s.replace(/'/g, "'\\''")}'`).join(" ")}`;
  const conc = Math.max(1, Math.min(list.length, js.concurrency || list.length));
  const tag = (d) => { d.set("jobLabel", [...new Set([...(js.jobLabel || []), "rerun-failed"])]); d.set("concurrency", conc); };
  if (String(js.version) !== "0.2" && js.autosplit && /\$test/.test(js.testRunnerCommand || "")) {
    doc.set("testDiscovery", { type: "raw", mode: "local", command: discovery });
    tag(doc);
    return doc.toString({ lineWidth: 0 });
  }
  if (js.matrix && Array.isArray(js.matrix.test)) {
    doc.setIn(["matrix", "test"], list);
    tag(doc);
    return doc.toString({ lineWidth: 0 });
  }
  // v0.2 or tag-based matrix: build a v0.1 autosplit YAML for just these tests, carrying the fixes over.
  if (!generate) return null;
  const level = selectors.levels?.[0];
  const splitBy = { method: profile.language === "python" ? "method" : "method", class: "class", scenario: "scenario", file: "file" }[level] || undefined;
  const base = YAML.parseDocument(generate({ yamlVersion: "0.1", executionMode: "autosplit", splitBy, discoveryCommand: discovery, runson: js.runson, concurrency: conc }));
  for (const k of ["env", "tunnel", "runtime", "idleTimeout", "globalTimeout", "testSuiteTimeout", "testSuiteStep"]) if (js[k] !== undefined) base.set(k, js[k]);
  const extraPre = (js.pre || []).filter((c) => /chmod \+x|playwright install|pip3? install [^-]/.test(c));
  if (extraPre.length) base.set("pre", [...new Set([...(base.toJS().pre || []), ...extraPre])]);
  base.setIn(["testDiscovery", "mode"], "local");
  base.set("jobLabel", ["rerun-failed"]);
  return base.toString({ lineWidth: 0 });
}

// Tests whose YAML fix will actually be applied (a fix needing a value the user hasn't given is skipped).
export function fixableSelectors(diagnosis, values = {}) {
  const list = (diagnosis.tests?.list || []).filter((t) => t.cause === "yaml" && t.fixKey && t.selector && (!t.needsValue || values[t.needsValue]));
  const levels = list.map((t) => (t.selector.includes("::") ? "method" : /\.feature:\d+$/.test(t.selector) ? "scenario" : /#/.test(t.selector) ? "method" : /\//.test(t.selector) ? "file" : "class"));
  return Object.assign(list.map((t) => t.selector), { levels });
}
