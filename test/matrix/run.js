// Framework matrix: for every repo under the given folders, do what the MCP tools do — analyze, generate,
// validate, run the discovery command against the real files — and compare with the repo's own HyperExecute
// YAML when it has one. Writes a JSON report and prints a table.
//
//   node test/matrix/run.js <folder-with-repos> [more folders…] [--out report.json] [--only name,name]
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import YAML from "yaml";
import { analyzeRepo, summarizeProfile } from "../../src/analyzer.js";
import { generateYaml } from "../../src/generator.js";
import { validateYaml } from "../../src/validator.js";

process.env.HE_LEARN = "off";
process.env.HE_GISTS = "off";
process.env.HE_DOCS = "off";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null; };
const outFile = flag("--out") || "matrix-report.json";
const only = flag("--only")?.split(",");
const dirs = args;

const sh = (cmd, cwd, timeout = 60000) => new Promise((resolve) => execFile("bash", ["-c", cmd], { cwd, timeout, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout: String(stdout), stderr: String(stderr) })));

// The repo's own HyperExecute YAMLs (the reference a human wrote), summarized
function referenceYamls(repo) {
  const out = [];
  const walk = (d, depth = 0) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!/^(node_modules|\.git|target|build|dist|bin|obj)$/.test(e.name)) walk(path.join(d, e.name), depth + 1); continue; }
      if (!/\.ya?ml$/i.test(e.name)) continue;
      const file = path.join(d, e.name);
      let doc;
      try { doc = YAML.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
      if (!doc || typeof doc !== "object" || !(doc.testRunnerCommand || doc.framework || doc.testSuites || doc.runson)) continue;
      out.push({ file: path.relative(repo, file), version: String(doc.version ?? ""), framework: doc.framework?.name, runson: doc.runson, mode: doc.matrix ? "matrix" : doc.autosplit ? "autosplit" : doc.framework ? "framework" : "?", runner: String(doc.testRunnerCommand || doc.testSuites?.[0] || "").slice(0, 140), discovery: String(doc.testDiscovery?.command || "").slice(0, 140) });
    }
  };
  try { walk(repo); } catch {}
  return out;
}

async function one(name, repo) {
  const r = { name, repo };
  const t0 = Date.now();
  try {
    const p = analyzeRepo(repo);
    const s = summarizeProfile(p, 5);
    Object.assign(r, { language: p.language, buildTool: p.buildTool || p.packageManager, framework: p.primaryFramework, frameworks: p.frameworks, confidence: s.confidence?.level, questions: s.questions?.length || 0, tests: { classes: s.tests.classCount, methods: s.tests.methodCount, files: s.tests.fileCount, features: s.tests.featureCount, scenarios: s.tests.scenarioCount } });
    r.reference = referenceYamls(repo);
    if (!p.primaryFramework) { r.verdict = "NO_FRAMEWORK"; return r; }
    let g;
    try { g = generateYaml(p, {}); } catch (e) { r.verdict = "GENERATE_ERROR"; r.error = e.message; return r; }
    // values only the user knows: the agent asks for them; here the "user" answers, and the run goes on
    const asked = [...g.yaml.matchAll(/^\s+(\w+): <set \w+>$/gm)].map((m) => m[1]);
    const askedProps = [...g.yaml.matchAll(/-D([\w.-]+)="<set /g)].map((m) => m[1]);
    if (asked.length || askedProps.length) {
      r.needsInput = [...asked, ...askedProps.map((x) => `-D${x}`)];
      g = generateYaml(p, { extraEnv: Object.fromEntries(asked.map((k) => [k, "answer-from-user"])), extraSysProps: Object.fromEntries(askedProps.map((k) => [k, "answer-from-user"])) });
    }
    const doc = YAML.parse(g.yaml);
    Object.assign(r, { yamlVersion: g.yamlVersion, mode: g.executionMode, splitBy: g.splitBy, runner: String(doc.testRunnerCommand || doc.framework?.name || "").slice(0, 160), pre: doc.pre, warnings: g.warnings });
    const v = validateYaml(g.yaml, repo);
    r.validation = { valid: v.valid, errors: v.errors, warnings: v.warnings };
    r.yaml = g.yaml;
    if (!v.valid) { r.verdict = "INVALID_YAML"; return r; }
    if (doc.testDiscovery?.command) {
      const d = await sh(doc.testDiscovery.command, repo);
      const items = d.stdout.split("\n").map((x) => x.trim()).filter(Boolean);
      r.discovery = { command: doc.testDiscovery.command, count: items.length, sample: items.slice(0, 3), exit: d.code, stderr: d.stderr.slice(0, 300) };
      r.verdict = items.length ? "OK" : "ZERO_DISCOVERY";
    } else r.verdict = doc.framework ? "OK_NATIVE" : doc.matrix ? "OK_MATRIX" : "OK";
  } catch (e) {
    r.verdict = "CRASH";
    r.error = e.stack?.split("\n").slice(0, 3).join(" | ");
  } finally {
    r.ms = Date.now() - t0;
  }
  return r;
}

const repos = [];
for (const d of dirs) for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith(".") && (!only || only.includes(e.name))) repos.push([e.name, path.join(d, e.name)]);
const results = [];
for (const [name, repo] of repos.sort()) {
  const r = await one(name, repo);
  results.push(r);
  const tests = r.tests ? Object.entries(r.tests).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ") : "";
  console.log(`${(r.verdict || "").padEnd(15)} ${name.padEnd(55)} ${(r.framework || "-").padEnd(14)} ${(r.yamlVersion ? "v" + r.yamlVersion : "").padEnd(5)} ${r.discovery ? `disc ${r.discovery.count}` : ""} ${tests}`);
}
fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
const by = results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
console.log("\n", by, `\nreport: ${outFile}`);
