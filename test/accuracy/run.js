// Accuracy check: generates a YAML for each case and compares it with what is known to be right.
//
//   npm run accuracy                     all cases, fails if the score drops below baseline.json
//   npm run accuracy -- --update-baseline  accept the current score as the new baseline
//   npm run accuracy -- --verbose          show every check
//
// Cases:
//   test/accuracy/cases/*.json                     committed, point at test/fixtures
//   $HE_ACCURACY_CASES/<name>/case.json            private (customer repos): never commit these
//       + expected.yaml (a hand-tuned YAML that ran correctly on HyperExecute)
//       + repo/ (a copy of the repo) or "repo": "/abs/path" in case.json
//
// case.json: { "name", "repo", "options": {generator options}, "expected": { … }, "expectedYaml": "expected.yaml" }
// "ignore": ["check name", …] skips checks that reflect the reference's own strategy (add a "why").
// expected (all optional): language, framework, yamlVersion, splitBy, executionMode, runson, v02Name, discoveryType,
//   discovered (item count from the generated discovery command), runnerContains [..], runnerNotContains [..],
//   preContains [..], env [keys that must be in env], confidence ("high" | "medium" | "low"), questionsInclude [..]
// With expectedYaml, runson / version / framework.name / runner flags / env keys / discovered count are taken from it.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { analyzeRepo } from "../../src/analyzer.js";
import { generateYaml } from "../../src/generator.js";
import { validateYaml } from "../../src/validator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const verbose = args.has("--verbose");

// ---------- load cases ----------

function loadCases() {
  const cases = [];
  const dir = path.join(here, "cases");
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
    const c = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    for (const one of [].concat(c)) cases.push({ ...one, repo: path.resolve(here, "..", "fixtures", one.repo), origin: "committed" });
  }
  const priv = process.env.HE_ACCURACY_CASES;
  if (priv && fs.existsSync(priv)) {
    for (const d of fs.readdirSync(priv, { withFileTypes: true }).filter((e) => e.isDirectory() && !/^[_.]/.test(e.name))) {
      const base = path.join(priv, d.name);
      const cf = path.join(base, "case.json");
      const c = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, "utf8")) : {};
      const repo = c.repo ? path.resolve(base, c.repo) : path.join(base, "repo");
      const ey = path.join(base, c.expectedYaml || "expected.yaml");
      cases.push({ name: c.name || d.name, options: {}, expected: {}, ...c, repo, expectedYamlText: fs.existsSync(ey) ? fs.readFileSync(ey, "utf8") : null, origin: "private" });
    }
  }
  return cases;
}

// ---------- helpers ----------

const IGNORED_FLAGS = /^(-Dmaven\.repo\.local|-DfailIfNoTests|-Dsurefire\.failIfNoSpecifiedTests|--junitxml|--logger|--results-directory|--no-daemon|--no-build|--outputdir|-f|-o|--format|-B|-q|--batch-mode)$/;
const flags = (cmd) => new Set(String(cmd || "").split(/\s+/).filter((t) => /^-/.test(t)).map((t) => t.split("=")[0]).filter((t) => !IGNORED_FLAGS.test(t)));
const runnerOf = (doc) => doc.testRunnerCommand || (doc.testSuites || [])[0] || "";
const envKeys = (doc) => Object.keys(doc.env || {}).filter((k) => !/^(LT_USERNAME|LT_ACCESS_KEY|CACHE_DIR|GRADLE_USER_HOME|NUGET_PACKAGES)$/.test(k));

function discover(cmd, repo) {
  try {
    const out = execFileSync("bash", ["-c", cmd], { cwd: repo, timeout: 60000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").map((s) => s.trim()).filter(Boolean).length;
  } catch {
    return null;
  }
}

function expectationsFromYaml(text, repo) {
  const d = YAML.parse(text.replace(/\$\{\{[^}]*\}\}/g, "x")) || {};
  const e = { runson: d.runson, yamlVersion: String(d.version) };
  if (d.framework?.name) Object.assign(e, { v02Name: d.framework.name, discoveryType: d.framework.discoveryType });
  if (d.testDiscovery?.command) e.discovered = discover(d.testDiscovery.command, repo);
  const r = runnerOf(d);
  if (r) e.runnerFlags = [...flags(r)];
  e.executionMode = d.matrix && !d.autosplit ? "matrix" : "autosplit";
  e.env = envKeys(d);
  return e;
}

// ---------- run ----------

const report = [];
for (const c of loadCases()) {
  const checks = [];
  // kind "must": the YAML is wrong without it · "style": differs from the reference YAML's own choices (extra flags, env names)
  const add = (name, ok, got, want, kind = "must") => { if (!(c.ignore || []).includes(name)) checks.push({ name, ok: !!ok, got, want, kind }); };
  let profile;
  let gen;
  let doc = {};
  // With an expected YAML, generate with the same version / mode / OS so like is compared with like.
  let opts = c.options || {};
  if (c.expectedYamlText && c.matchExpected !== false) {
    try {
      const d = YAML.parse(c.expectedYamlText.replace(/\$\{\{[^}]*\}\}/g, "x")) || {};
      const derived = { yamlVersion: String(d.version) === "0.2" ? "0.2" : "0.1", executionMode: d.matrix && !d.autosplit ? "matrix" : "autosplit" };
      if (["linux", "mac", "mac13", "win", "win11"].includes(d.runson)) derived.runson = d.runson;
      opts = { ...derived, ...opts };
    } catch {}
  }
  try {
    profile = analyzeRepo(c.repo);
    gen = generateYaml(profile, opts);
    doc = YAML.parse(gen.yaml) || {};
  } catch (e) {
    add("generates", false, e.message, "a YAML");
    report.push({ name: c.name, origin: c.origin, checks, score: 0 });
    continue;
  }
  const e = { ...(c.expectedYamlText ? expectationsFromYaml(c.expectedYamlText, c.repo) : {}), ...(c.expected || {}) };
  const v = validateYaml(gen.yaml, c.repo);
  // <set VAR> placeholders are deliberate (values only the user knows), so they don't count as wrong
  const errs = v.errors.filter((x) => !/still has a placeholder value/.test(x));
  add("validates", !errs.length, errs.join(" | ") || "ok", "no errors");
  if (e.language) add("language", profile.language === e.language, profile.language, e.language);
  if (e.framework) add("framework", gen.framework === e.framework, gen.framework, e.framework);
  if (e.yamlVersion) add("yamlVersion", String(doc.version) === String(e.yamlVersion), String(doc.version), String(e.yamlVersion));
  if (e.splitBy) add("splitBy", gen.splitBy === e.splitBy, gen.splitBy, e.splitBy);
  if (e.executionMode) add("executionMode", gen.executionMode === e.executionMode, gen.executionMode, e.executionMode);
  if (e.runson) add("runson", doc.runson === e.runson, doc.runson, e.runson);
  if (e.v02Name) add("framework.name", doc.framework?.name === e.v02Name, doc.framework?.name, e.v02Name);
  if (e.discoveryType) add("discoveryType", doc.framework?.discoveryType === e.discoveryType, doc.framework?.discoveryType, e.discoveryType);
  if (e.discovered !== undefined && e.discovered !== null) {
    const got = doc.testDiscovery?.command ? discover(doc.testDiscovery.command, c.repo) : null;
    add("discovered count", got === e.discovered, got, e.discovered);
  }
  const runner = runnerOf(doc);
  for (const s of e.runnerContains || []) add(`runner has ${s}`, runner.includes(s), runner, s);
  for (const s of e.runnerNotContains || []) add(`runner lacks ${s}`, !runner.includes(s), runner, `no ${s}`);
  if (e.runnerFlags) {
    const got = flags(runner);
    const missing = e.runnerFlags.filter((f) => !got.has(f));
    add("runner flags", !missing.length, [...got].join(" "), missing.length ? `missing ${missing.join(" ")}` : "same flags", c.expected?.runnerFlags ? "must" : "style");
  }
  const pre = (doc.pre || []).join(" && ");
  for (const s of e.preContains || []) add(`pre has ${s}`, pre.includes(s), pre, s);
  if (e.env) {
    const got = envKeys(doc);
    const missing = e.env.filter((k) => !got.includes(k));
    add("env keys", !missing.length, got.join(","), missing.length ? `missing ${missing.join(",")}` : "all present", c.expected?.env ? "must" : "style");
  }
  if (e.confidence) add("confidence", profile.confidence.level === e.confidence, profile.confidence.level, e.confidence);
  for (const s of e.questionsInclude || []) add(`asks about ${s}`, profile.questions.some((q) => q.includes(s)), profile.questions.join(" / "), s);
  const must = checks.filter((x) => x.kind === "must");
  const score = must.filter((x) => x.ok).length / (must.length || 1);
  report.push({ name: c.name, origin: c.origin, checks, score });
}

// ---------- output ----------

const pct = (x) => `${Math.round(x * 1000) / 10}%`;
const mustChecks = report.flatMap((r) => r.checks.filter((x) => x.kind === "must"));
const styleChecks = report.flatMap((r) => r.checks.filter((x) => x.kind === "style"));
const totalChecks = mustChecks.length;
const passedChecks = mustChecks.filter((x) => x.ok).length;
const overall = totalChecks ? passedChecks / totalChecks : 0;
for (const r of report) {
  console.log(`${r.score === 1 ? "PASS" : "MISS"}  ${pct(r.score).padStart(6)}  ${r.name}${r.origin === "private" ? "  (private)" : ""}`);
  for (const x of r.checks) if (verbose || !x.ok) console.log(`        ${x.ok ? "ok " : x.kind === "style" ? "~  " : "✗  "} ${x.name}: got ${JSON.stringify(x.got)}${x.ok ? "" : `, want ${JSON.stringify(x.want)}`}`);
}
console.log(`\nAccuracy: ${pct(overall)} (${passedChecks}/${totalChecks} checks, ${report.length} cases)`);
if (styleChecks.length) console.log(`Matches reference style: ${pct(styleChecks.filter((x) => x.ok).length / styleChecks.length)} (${styleChecks.filter((x) => x.ok).length}/${styleChecks.length}; "~" rows — flags/env names the reference chose, not errors)`);

// Separate baselines: committed fixtures, and private cases (which differ per machine)
const baseFile = path.join(here, "baseline.json");
const base = fs.existsSync(baseFile) ? JSON.parse(fs.readFileSync(baseFile, "utf8")) : {};
const scoreOf = (origin) => {
  const m = report.filter((r) => r.origin === origin).flatMap((r) => r.checks.filter((x) => x.kind === "must"));
  return m.length ? m.filter((x) => x.ok).length / m.length : null;
};
const scores = { committed: scoreOf("committed"), private: scoreOf("private") };
fs.writeFileSync(path.join(here, "last-report.json"), JSON.stringify({ at: new Date().toISOString(), overall, scores, cases: report.map((r) => ({ name: r.name, origin: r.origin, score: r.score, failed: r.checks.filter((x) => !x.ok) })) }, null, 2));
if (args.has("--update-baseline")) {
  const next = { ...base };
  for (const [k, v] of Object.entries(scores)) if (v !== null) next[k] = Math.floor(v * 1000) / 1000;
  delete next.minScore;
  next.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(baseFile, JSON.stringify(next, null, 2) + "\n");
  console.log(`Baseline set: ${Object.entries(scores).filter(([, v]) => v !== null).map(([k, v]) => `${k} ${pct(v)}`).join(", ")}.`);
} else {
  let failed = false;
  for (const [k, v] of Object.entries(scores)) {
    const min = base[k] ?? (k === "committed" ? base.minScore : undefined);
    if (v === null || min === undefined) continue;
    const ok = v + 1e-9 >= min;
    failed ||= !ok;
    console.log(`${k}: ${pct(v)} (baseline ${pct(min)}) ${ok ? "OK" : "BELOW BASELINE"}`);
  }
  if (failed) process.exit(1);
}
