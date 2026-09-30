// Diagnoses a finished HyperExecute run from its CLI output and downloaded logs, and turns known
// failure patterns into YAML changes. Genuine test failures are reported, never "fixed" by rerunning.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { toSelector, testLabel, collectTestResults, parseResultFile } from "./results.js";

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

// Reads CLI output plus any log/report files the CLI downloaded during this run.
export function collectEvidence({ output = "", repoPath, since, artifactsDir }) {
  const files = [];
  const resultFiles = [];
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
        if (!/\.(log|txt|json|xml|html?)$/i.test(e.name) || st.size > 2 * 1024 * 1024 || budget <= 0) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (/^src\/|\/src\//.test(rel) || rel === "hyperexecute.yaml") continue;
        const text = fs.readFileSync(full, "utf8").slice(0, budget);
        budget -= text.length;
        files.push({ file: rel, text: e.name.endsWith(".html") ? text.replace(/<[^>]+>/g, " ") : text });
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
    jobId: (all.match(/jobId[=:"\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) || all.match(/job[ _-]?id\W+([\w-]{8,})/i) || [])[1] || null,
    jobUrl: (all.match(/https:\/\/[\w.-]*(?:hyperexecute|lambdatest|testmuai)[\w.-]*\/[^\s"')]*job[^\s"')]*/i) || [])[0] || null,
  };
}

// ---------- rules ----------

const excerpt = (text, re, radius = 1) => {
  const lines = text.split("\n");
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return "";
  return lines.slice(Math.max(0, i - radius), i + radius + 1).join("\n").slice(0, 600);
};

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
    id: "playwright-browsers", category: "environment",
    re: /(Executable doesn't exist at .*ms-playwright|browserType\.launch: Executable doesn't exist|Please run the following command to download new browsers|playwright install)/i,
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
    re: /(hub\.lambdatest\.com|cdp\.lambdatest\.com)[^\n]*(401|Unauthorized)|Unauthorized[^\n]*lambdatest|(username|access ?key)[^\n]*(null|undefined|empty)|Invalid username or access ?key/i,
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
    advice: "Create secrets named LT_USERNAME and LT_ACCESS_KEY in HyperExecute (Settings → Secrets) for your account.",
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
    re: /(Could not resolve dependencies|Could not transfer artifact|Failed to read artifact descriptor|npm ERR! (code E|network)|ERR_PNPM_FETCH|No matching distribution found|Could not find a version that satisfies|Unable to load the service index|NU1301)/i,
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
    re: /(AssertionError|AssertionFailedError|expected:? ?<[^>]*> but was|Tests run: \d+, Failures: [1-9]|\d+ failed(,| \()|FAILED \(failures=|Error: expect\(|✘|NoSuchElementException|ElementNotInteractableException|TimeoutException: .*waiting for)/i,
    title: "Tests failed on assertions / element lookups",
    why: "The run worked; the tests themselves failed. That's an application or test issue, not the YAML.",
    advice: "Open the failing tests in the HyperExecute dashboard. Rerunning won't fix these — retryOnFailure already covers flaky ones.",
  },
];

// ---------- diagnosis ----------

export function diagnose({ evidence, yamlText, profile, exitCode, v02Name }) {
  const text = evidence.text || "";
  const doc = YAML.parseDocument(yamlText || "");
  const js = doc.toJS() || {};
  const ctx = { text, js, profile, v02: !!v02Name };
  const found = [];
  for (const r of RULES) {
    if (!r.re.test(text)) continue;
    let fix = null;
    try { fix = r.fix ? r.fix(ctx) : null; } catch { fix = null; }
    found.push({ id: r.id, category: r.category, title: r.title, why: r.why, advice: r.advice || null, evidence: excerpt(text, r.re), fix, stop: !!r.stop, notYaml: !!r.notYaml });
  }
  // Per-test classification when the job produced reports.
  const tests = evidence.tests || [];
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
  const status =
    found.some((f) => f.id === "cli-auth") ? "auth-error" :
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
    jobId: evidence.jobId,
    jobUrl: evidence.jobUrl,
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

// Compact log excerpt for the AI when no rule matched: error-looking lines plus the tail.
export function logDigest(text, max = 6000) {
  const lines = text.split("\n");
  const errs = lines.filter((l) => /\b(error|exception|failed|failure|fatal|denied|not found|timed? ?out|refused|ERR::)\b/i.test(l)).slice(-60);
  const tail = lines.slice(-60);
  return [...new Set([...errs, "----- tail -----", ...tail])].join("\n").slice(-max);
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
    fix: (ctx) => (ctx.js.env?.LT_USERNAME && ctx.js.env?.LT_ACCESS_KEY ? { none: "Create secrets LT_USERNAME / LT_ACCESS_KEY in HyperExecute for your account" } : { key: "lt-secrets", summary: "Map LT_USERNAME / LT_ACCESS_KEY from HyperExecute secrets", patch: (d) => { d.setIn(["env", "LT_USERNAME"], "${{ .secrets.LT_USERNAME }}"); d.setIn(["env", "LT_ACCESS_KEY"], "${{ .secrets.LT_ACCESS_KEY }}"); } }) },
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
