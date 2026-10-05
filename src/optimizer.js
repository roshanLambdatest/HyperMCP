// Suggests (and applies) speed/cost/reliability improvements to a HyperExecute YAML.
// Edits go through the yaml Document API so comments and layout survive.

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { v02FrameworkName } from "./generator.js";

const SEVERITY_ORDER = { high: 0, medium: 1, low: 2 };

function strList(node) {
  const v = node?.toJSON ? node.toJSON() : node;
  return Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];
}

function readMaybe(root, rel) {
  try { return fs.readFileSync(path.join(root, rel), "utf8"); } catch { return ""; }
}

// Each rule: (ctx) => suggestion | null. A suggestion: {id, severity, category, title, why, apply(doc)}.
const RULES = [
  // --- pre step runs the whole suite on every VM ---
  ({ doc, js }) => {
    const pre = strList(doc.get("pre"));
    const i = pre.findIndex((c) => /\bmvn(w)?\b.*\b(install|package|verify)\b/.test(c) && !/-DskipTests|-Dmaven\.test\.skip/.test(c));
    if (i < 0) return null;
    return {
      id: "pre-skip-tests", severity: "high", category: "speed",
      title: "`pre` runs the whole test suite on every VM",
      why: `\`${pre[i]}\` runs all tests during setup, before HyperExecute splits them — every VM pays that time.`,
      apply: (d) => d.setIn(["pre", i], pre[i].replace(/\b(install|package|verify)\b/, "$1 -Dmaven.test.skip=true")),
    };
  },
  ({ doc }) => {
    const pre = strList(doc.get("pre"));
    const i = pre.findIndex((c) => /gradlew?\b.*\bbuild\b/.test(c) && !/-x\s+test/.test(c));
    if (i < 0) return null;
    return { id: "pre-gradle-skip-tests", severity: "high", category: "speed", title: "`pre` runs Gradle tests on every VM", why: `\`${pre[i]}\` includes the test task.`, apply: (d) => d.setIn(["pre", i], pre[i] + " -x test") };
  },
  // --- caching ---
  ({ doc, js, profile }) => {
    if (String(js.version) === "0.2") return null; // v0.2 caches ~/.m2 / ~/.gradle / ~/.nuget automatically
    if (js.cacheKey && js.cacheDirectories) return null;
    const pre = strList(doc.get("pre")).join(" ");
    const pr = profile?.projectRoot ? profile.projectRoot + "/" : "";
    let key, dirs, env;
    if (/\bmvn/.test(pre)) (key = `${pr}pom.xml`), (dirs = ["$CACHE_DIR"]), (env = { CACHE_DIR: "m2_cache_dir" });
    else if (/gradle/.test(pre)) (key = `${pr}${profile?.primaryBuildFile || "build.gradle"}`), (dirs = ["gradle_cache"]), (env = { GRADLE_USER_HOME: "gradle_cache" });
    else if (/\bnpm (ci|install)|yarn|pnpm/.test(pre)) (key = profile?.lockFile || "package.json"), (dirs = ["node_modules"]);
    else if (/pip3? install/.test(pre)) (key = profile?.requirementsFile || "requirements.txt"), (dirs = ["pip_cache"]);
    else return null;
    return {
      id: "add-cache", severity: "high", category: "speed",
      title: "No dependency cache",
      why: "Every VM downloads all dependencies from scratch. A cache keyed on the dependency file makes later runs start much faster.",
      apply: (d) => {
        d.set("cacheKey", `{{ checksum "${key}" }}`);
        d.set("cacheDirectories", dirs);
        if (env) for (const [k, v] of Object.entries(env)) d.setIn(["env", k], v);
        if (dirs[0] === "$CACHE_DIR") mavenRepoLocal(d);
        if (dirs[0] === "pip_cache") { const p = strList(d.get("pre")); p.forEach((c, i) => /pip3? install/.test(c) && !/--cache-dir/.test(c) && d.setIn(["pre", i], c + " --cache-dir pip_cache")); }
      },
    };
  },
  ({ doc, js }) => {
    if (!js.cacheDirectories || !strList(doc.get("cacheDirectories")).includes("$CACHE_DIR")) return null;
    const cmds = [...strList(doc.get("pre")), js.testRunnerCommand || "", ...strList(doc.get("testSuites"))].filter((c) => /\bmvn/.test(c));
    if (!cmds.length || cmds.every((c) => /maven\.repo\.local/.test(c))) return null;
    return { id: "maven-repo-local", severity: "high", category: "speed", title: "Maven ignores the cache directory", why: "Some mvn commands lack -Dmaven.repo.local=$CACHE_DIR, so they re-download dependencies instead of using the cache.", apply: (d) => mavenRepoLocal(d) };
  },
  ({ doc, profile }) => {
    const pre = strList(doc.get("pre"));
    const i = pre.findIndex((c) => /\bnpm install\b/.test(c) && !/-g\b/.test(c));
    if (i < 0 || !(profile?.lockFile === "package-lock.json")) return null;
    return { id: "npm-ci", severity: "low", category: "reliability", title: "Use `npm ci` instead of `npm install`", why: "`npm ci` installs exactly what package-lock.json pins — faster and reproducible.", apply: (d) => d.setIn(["pre", i], pre[i].replace(/\bnpm install\b/, "npm ci")) };
  },
  // --- concurrency vs amount of work ---
  ({ js, units }) => {
    if (!units || !js.concurrency || js.concurrency <= units) return null;
    return { id: "concurrency-cap", severity: "medium", category: "cost", title: `Concurrency ${js.concurrency} is higher than the ${units} test units`, why: `Only ${units} tasks can run at once, so ${js.concurrency - units} VMs would sit idle.`, apply: (d) => d.set("concurrency", units) };
  },
  ({ js, units }) => {
    if (!units || !js.concurrency || units / js.concurrency < 25) return null;
    const suggested = Math.min(units, Math.ceil(units / 10));
    return { id: "concurrency-raise", severity: "low", category: "speed", title: `~${Math.round(units / js.concurrency)} test units per VM`, why: `With ${units} units on ${js.concurrency} VMs, the run is long. Raising concurrency (e.g. to ${suggested}, within your plan's limit) shortens it proportionally.`, apply: (d) => d.set("concurrency", suggested) };
  },
  // --- split granularity ---
  ({ doc, js, profile }) => {
    if (!profile || js.autosplit !== true) return null;
    const classes = profile.tests.classes.length;
    const methods = profile.tests.classes.reduce((n, c) => n + (c.methods?.length || 0), 0);
    const conc = js.concurrency || 1;
    const byClass = String(js.version) === "0.2" ? js.framework?.discoveryType === "class" : /\$test/.test(js.testRunnerCommand || "") && /s#\/#\.#g'\s*$/.test(js.testDiscovery?.command || "");
    if (!byClass || classes >= conc || methods < conc * 2 || classes === 0) return null;
    return {
      id: "split-method", severity: "medium", category: "speed",
      title: `Only ${classes} classes for ${conc} VMs — split by method`,
      why: `Class-level splitting can't use more than ${classes} VMs, and the biggest class sets the run time. ${methods} methods would spread evenly. Keep class-level if tests in a class share state (@BeforeClass).`,
      apply: (d) => {
        if (String(js.version) === "0.2") d.setIn(["framework", "discoveryType"], "method");
        else return "regenerate:splitBy=method";
      },
    };
  },
  // --- matrix of test names → autosplit load-balancing ---
  ({ js }) => {
    if (!js.matrix || js.autosplit) return null;
    const testKey = Object.keys(js.matrix).find((k) => !["os", "browser", "browsers", "tag", "tags", "run"].includes(k) && Array.isArray(js.matrix[k]) && js.matrix[k].length >= 4);
    if (!testKey) return null;
    return { id: "matrix-to-autosplit", severity: "medium", category: "speed", title: "Matrix lists individual tests — autosplit would balance them", why: `matrix.${testKey} has ${js.matrix[testKey].length} fixed entries, so slow ones can pile onto one VM. Autosplit discovers tests and balances them using past durations.`, apply: () => "regenerate:executionMode=autosplit" };
  },
  // --- v0.1 → v0.2 ---
  ({ js, profile }) => {
    if (String(js.version) === "0.2" || js.matrix || !profile) return null;
    const name = v02FrameworkName(profile, profile.primaryFramework);
    if (!name) return null;
    return { id: "upgrade-v02", severity: "medium", category: "reliability", title: `Use YAML v0.2 (${name})`, why: "HyperExecute's native runner discovers tests itself (no grep command to maintain), shards by method/class/suite XML, and caches dependencies automatically.", apply: () => "regenerate:yamlVersion=0.2" };
  },
  // --- retries ---
  ({ js }) => {
    if (!(js.maxRetries > 2)) return null;
    return { id: "retries-cap", severity: "medium", category: "cost", title: `maxRetries ${js.maxRetries} hides flaky tests and costs time`, why: "Each retry re-runs the failing task. 1–2 retries catch infrastructure blips; more mostly masks real failures.", apply: (d) => d.set("maxRetries", 2) };
  },
  ({ js }) => {
    if (js.retryOnFailure !== undefined) return null;
    return { id: "retries-add", severity: "low", category: "reliability", title: "No retry on failure", why: "A single retry absorbs one-off grid or network hiccups without masking consistent failures.", apply: (d) => { d.set("retryOnFailure", true); d.set("maxRetries", 1); } };
  },
  // --- discovery on Windows ---
  ({ js }) => {
    if (!/^win/.test(js.runson || "") || js.testDiscovery?.mode !== "remote" || !/\b(grep|sed|awk|find)\b/.test(js.testDiscovery?.command || "")) return null;
    return { id: "win-local-discovery", severity: "medium", category: "reliability", title: "bash discovery runs remotely on Windows", why: "grep/sed/awk may be missing on Windows VMs. `mode: local` runs discovery on the machine that launches the CLI.", apply: (d) => d.setIn(["testDiscovery", "mode"], "local") };
  },
  // --- in-framework parallelism fighting HyperExecute ---
  ({ js, root, profile }) => {
    const runner = [js.testRunnerCommand || "", ...(js.testSuites || [])].join(" ");
    if (/pytest\b.*\s-n\s*\d+|--workers[= ]\d+|-Dparallel=|threadCount/.test(runner)) {
      return { id: "inner-parallel", severity: "medium", category: "reliability", title: "Runner adds its own parallelism", why: "pytest -n / Playwright --workers / TestNG threads inside each VM compete with HyperExecute's concurrency and overload the VM.", apply: (d) => {
        if (js.testRunnerCommand) d.set("testRunnerCommand", js.testRunnerCommand.replace(/\s-n\s*\d+/, "").replace(/--workers[= ]\d+/, "--workers=1").replace(/\s-Dparallel=\w+/, "").replace(/\s-DthreadCount=\d+/, ""));
      } };
    }
    if (profile?.primaryFramework === "playwright" && profile.configFile) {
      const w = readMaybe(root, profile.configFile).match(/workers\s*:\s*(\d+)/);
      if (w && +w[1] > 1 && !/--workers/.test(runner)) return { id: "pw-workers", severity: "medium", category: "reliability", title: `playwright.config uses ${w[1]} workers`, why: "Each HyperExecute task already runs on its own VM; extra workers per VM slow it down and cause flaky timeouts.", apply: (d) => d.set("testRunnerCommand", `${js.testRunnerCommand} --workers=1`) };
    }
    return null;
  },
  // --- artefacts ---
  ({ js }) => {
    const broad = (js.uploadArtefacts || []).some((a) => (a.path || []).some((p) => /^(\*\*|target\/\*\*|build\/\*\*|\.\/?\*\*)$/.test(p) || /\/target\/\*\*$/.test(p)));
    if (!broad) return null;
    return { id: "narrow-artefacts", severity: "low", category: "speed", title: "Artefact upload includes the whole build folder", why: "Uploading target/** or build/** (jars, classes, caches) slows every task's upload stage. Upload only report folders.", apply: (d) => {
      const list = d.get("uploadArtefacts");
      (js.uploadArtefacts || []).forEach((a, i) => d.setIn(["uploadArtefacts", i, "path"], (a.path || []).map((p) => p.replace(/(^|\/)(target|build)\/\*\*$/, "$1$2/surefire-reports/**").replace(/^\*\*$/, "reports/**"))));
      return list;
    } };
  },
  ({ js }) => {
    if (!js.uploadArtefacts || js.mergeArtifacts !== undefined) return null;
    return { id: "merge-artifacts", severity: "low", category: "usability", title: "Artefacts aren't merged", why: "`mergeArtifacts: true` combines each task's reports into one download.", apply: (d) => d.set("mergeArtifacts", true) };
  },
  // --- big repos ---
  ({ js, profile }) => {
    if (js.differentialUpload || !profile || profile.fileCount < 3000) return null;
    return { id: "differential-upload", severity: "low", category: "speed", title: `Large repo (${profile.fileCount} files) uploaded in full each run`, why: "differentialUpload only uploads files that changed since the last run (field setups keep the cache 100 hours).", apply: (d) => d.set("differentialUpload", { enabled: true, ttlHours: 100 }) };
  },
  // --- mac without a reason ---
  ({ js, profile }) => {
    if (!/^mac/.test(js.runson || "") || !profile) return null;
    if (/safari|webkit|xcuitest|ios/i.test(JSON.stringify(profile.drivers) + JSON.stringify(profile.dependencies))) return null;
    return { id: "linux-over-mac", severity: "low", category: "cost", title: "Runs on macOS without needing Safari/iOS", why: "Linux VMs start faster. Keep mac only if the customer needs Safari/WebKit or macOS specifically.", apply: (d) => d.set("runson", "linux") };
  },
  // ---- learned from field YAMLs (LambdaTest samples + the team's gist pool) and the YAML reference ----
  // an app server started in pre blocks it (or dies with it); background runs it next to the tests
  ({ doc, js }) => {
    const pre = strList(doc.get("pre"));
    const i = pre.findIndex((c) => /(\bnpm (run )?(start|serve|dev)\b|\byarn (start|serve|dev)\b|\bnx serve\b|\bhttp-server\b|\bstatic-server\b|\bserve\s+-|python3? -m http\.server|java -jar \S+\.jar|docker compose up|docker-compose up)/.test(c) && !/\bwait-on\b|start-server-and-test/.test(c));
    if (i < 0 || js.background) return null;
    return { id: "background-server", severity: "high", category: "reliability", title: "A server is started in `pre`", why: `\`${pre[i]}\` keeps running, so pre never finishes (or the server stops when pre ends). \`background:\` starts it alongside pre and keeps it up until post, on every VM.`, apply: (d) => {
      d.set("background", [pre[i].replace(/\s*&\s*$/, "")]);
      d.deleteIn(["pre", i]);
    } };
  },
  // stop paying for a job whose tests keep failing the same way
  ({ js, units }) => {
    if (js.failFast || !units || units < 20) return null;
    return { id: "fail-fast", severity: "medium", category: "cost", title: `No failFast on a ${units}-unit job`, why: "When a shared problem (app down, bad build) fails test after test, failFast aborts the job after N consecutive failures instead of running every unit. Retries count once.", apply: (d) => d.set("failFast", { maxNumberOfTests: Math.max(5, Math.round(units / 10)) }) };
  },
  // tasks that end up with no tests (a filtered or targeted run) shouldn't fail on missing reports
  ({ js }) => {
    if (!js.uploadArtefacts || js.skipArtifactStageIfNoTest !== undefined) return null;
    if (!/--grep|-t |--tags|-m |--include|grepTags|\$tag/.test(String(js.testRunnerCommand || ""))) return null;
    return { id: "skip-artifacts-no-test", severity: "low", category: "reliability", title: "Filtered runs can leave tasks without reports", why: "With a tag/grep filter some tasks run no test; their artefact stage then fails the job. skipArtifactStageIfNoTest marks those stages skipped instead.", apply: (d) => d.set("skipArtifactStageIfNoTest", true) };
  },
  // Cypress downloads its binary on every VM unless the cache folder is cached too
  ({ js }) => {
    const cy = /cypress/.test(String(js.testRunnerCommand || "") + JSON.stringify(js.testSuites || ""));
    if (!cy || js.env?.CYPRESS_CACHE_FOLDER || !js.cacheDirectories) return null;
    return { id: "cypress-binary-cache", severity: "medium", category: "speed", title: "The Cypress binary is downloaded on every VM", why: "node_modules is cached but the Cypress app (~500 MB) lives in ~/.cache/Cypress. Setting CYPRESS_CACHE_FOLDER inside the repo and caching it skips that download (common in field setups).", apply: (d) => {
      d.setIn(["env", "CYPRESS_CACHE_FOLDER"], "cypressCache");
      const dirs = strList(d.get("cacheDirectories"));
      if (!dirs.includes("cypressCache")) d.set("cacheDirectories", [...dirs, "cypressCache"]);
    } };
  },
  // whole-scenario video for tests HyperExecute runs on the VM itself (no grid session to record)
  ({ js, profile }) => {
    if (js.captureScreenRecordingForScenarios !== undefined || !profile) return null;
    const onVm = ["cypress", "playwright", "testcafe", "codeceptjs", "gauge"].includes(profile.primaryFramework) && !profile.grid?.usesLambdaTestHub;
    if (!onVm) return null;
    return { id: "scenario-video", severity: "low", category: "usability", title: "No video of tests that run on the VM", why: "These tests drive a browser on the VM, not a grid session, so there's no session video. captureScreenRecordingForScenarios records each scenario (keep the framework's own video capability off: both together fail).", apply: (d) => d.set("captureScreenRecordingForScenarios", true) };
  },
  ({ js }) => {
    if (js.jobLabel) return null;
    return { id: "job-label", severity: "low", category: "usability", title: "No jobLabel", why: "Labels make jobs easy to find and filter on the HyperExecute dashboard.", apply: (d) => d.set("jobLabel", ["hyperexecute"]) };
  },
];

function mavenRepoLocal(d) {
  const fix = (c) => (/\bmvn/.test(c) && !/maven\.repo\.local/.test(c) ? c.replace(/\b(mvnw?|\.\/mvnw)\b/, "$1 -Dmaven.repo.local=$CACHE_DIR") : c);
  strList(d.get("pre")).forEach((c, i) => d.setIn(["pre", i], fix(c)));
  const r = d.get("testRunnerCommand");
  if (r) d.set("testRunnerCommand", fix(String(r)));
  strList(d.get("testSuites")).forEach((c, i) => d.setIn(["testSuites", i], fix(c)));
}

// units = how many test units autosplit would produce (from dry-run or profile), when known
export function optimizeYaml(text, { profile, units, repoPath } = {}) {
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) return { suggestions: [], error: doc.errors[0].message };
  const js = doc.toJS() || {};
  if (!units && profile && js.autosplit) {
    const t = profile.tests;
    const split = String(js.version) === "0.2" ? js.framework?.discoveryType : null;
    units = split === "method" ? t.classes.reduce((n, c) => n + (c.methods?.length || 0), 0) : split === "class" ? t.classes.length : /Scenario/.test(js.testDiscovery?.command || "") ? t.scenarios.length : /\.feature/.test(js.testDiscovery?.command || "") ? t.features.length : /while read f/.test(js.testDiscovery?.command || "") ? t.classes.reduce((n, c) => n + (c.methods?.length || 0), 0) || null : /::/.test(js.testDiscovery?.command || "") ? t.functions.length || null : t.classes.length || t.files.length || null;
  }
  const ctx = { doc, js, profile, units, root: repoPath || profile?.repoPath || "." };
  const suggestions = RULES.map((r) => { try { return r(ctx); } catch { return null; } }).filter(Boolean);
  suggestions.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { suggestions, units };
}

// Apply chosen suggestion ids. Returns the new YAML plus any "regenerate:*" hints the caller should
// handle with the generator (split/mode/version changes are better rebuilt than patched).
export function applyOptimizations(text, ids, opts = {}) {
  const { suggestions } = optimizeYaml(text, opts);
  const doc = YAML.parseDocument(text);
  const regenerate = {};
  const applied = [];
  for (const s of suggestions.filter((x) => ids === "all" || ids.includes(x.id))) {
    const r = s.apply(doc);
    if (typeof r === "string" && r.startsWith("regenerate:")) {
      const [k, v] = r.slice(11).split("=");
      regenerate[k] = v;
    }
    applied.push(s.id);
  }
  return { yaml: doc.toString({ lineWidth: 0 }), applied, regenerate };
}

export const describeSuggestions = (list) => list.map(({ apply, ...s }) => s);
