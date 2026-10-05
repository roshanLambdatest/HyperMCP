// Real HyperExecute runs through the MCP server, the way an agent drives it: generate (+ answers to its
// questions taken from the repo's own YAML), run, wait for the diagnosis, apply its fix once if it has one.
// Uses the LambdaTest account saved with set_lambdatest_credentials. Works on copies of the repos.
//
//   node test/matrix/real-runs.js <cases.json> [--parallel 3] [--out runs.json]
//   cases.json: [{ "name": "...", "repo": "/abs/path", "options": { ... } }]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : d; };
const parallel = +flag("--parallel", 3);
const outFile = flag("--out", "real-runs.json");
const cases = JSON.parse(fs.readFileSync(args[0], "utf8"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "he-real-"));
const here = path.dirname(new URL(import.meta.url).pathname);

const client = new Client({ name: "real-runs", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [path.join(here, "..", "..", "src", "index.js")], env: { ...process.env, HE_LEARN: "off", HE_GISTS: "off", HE_DOCS: "off" } }));
const call = async (name, a) => { const r = await client.callTool({ name, arguments: a }, undefined, { timeout: 600000 }); return { isError: r.isError, text: r.content[0].text }; };
const json = (r) => { try { return JSON.parse(r.text); } catch { return { raw: r.text }; } };

// values the user would give: the env the repo's own HyperExecute YAML sets
function referenceEnv(repo) {
  const env = {};
  const walk = (d, depth = 0) => {
    if (depth > 4) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!/^(node_modules|\.git|target|build)$/.test(e.name)) walk(path.join(d, e.name), depth + 1); continue; }
      if (!/\.ya?ml$/.test(e.name)) continue;
      try { const y = YAML.parse(fs.readFileSync(path.join(d, e.name), "utf8")); if (y?.env && (y.testRunnerCommand || y.framework)) for (const [k, v] of Object.entries(y.env)) if (!(k in env) && typeof v !== "object") env[k] = String(v); } catch {}
    }
  };
  walk(repo);
  return env;
}

async function one(c) {
  const t0 = Date.now();
  const repo = path.join(work, c.name);
  fs.cpSync(c.repo, repo, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules|target|build|bin|obj)$/.test(s) });
  const rec = { name: c.name, dir: repo, framework: null, attempts: [] };
  try {
    let g = await call("generate_hyperexecute_yaml", { repoPath: repo, concurrency: 2, ...c.options });
    const asked = [...g.text.matchAll(/^\s+(\w+): <set \w+>$/gm)].map((m) => m[1]);
    if (asked.length) {
      const ref = referenceEnv(c.repo);
      rec.asked = asked;
      rec.answeredFromReference = Object.fromEntries(asked.filter((k) => k in ref).map((k) => [k, ref[k]]));
    }
    const extraEnv = { ...(c.options?.extraEnv || {}), ...(rec.answeredFromReference || {}) };
    for (const k of asked) if (!(k in extraEnv)) extraEnv[k] = "hyperexecute"; // nothing to copy: a neutral value
    g = await call("generate_hyperexecute_yaml", { repoPath: repo, concurrency: 2, ...c.options, ...(Object.keys(extraEnv).length ? { extraEnv } : {}), write: true, outputFileName: "hyperexecute.yaml" });
    if (g.isError) throw new Error(`generate: ${g.text}`);
    rec.framework = (g.text.match(/framework: (\S+)/) || [])[1];
    rec.version = (g.text.match(/YAML v([\d.]+)/) || [])[1];
    let run = json(await call("run_hyperexecute_job", { repoPath: repo }));
    if (!run.runId) throw new Error(`run: ${run.raw || JSON.stringify(run)}`);
    for (let attempt = 1; attempt <= 2; attempt++) {
      let s;
      do { s = json(await call("get_hyperexecute_run", { runId: run.runId, waitSeconds: 60 })); } while (s.status === "running" && Date.now() - t0 < 45 * 60000);
      rec.attempts.push({ status: s.status, jobUrl: s.jobUrl, tests: s.diagnosis?.tests ? { total: s.diagnosis.tests.total, passed: s.diagnosis.tests.passed, failed: s.diagnosis.tests.failed, code: s.diagnosis.tests.code, yaml: s.diagnosis.tests.yaml } : undefined, discovery: s.discoveryCheck, problems: (s.diagnosis?.diagnoses || []).map((d) => `${d.id}: ${d.title}${d.fixSummary ? ` → ${d.fixSummary}` : ""}`), digest: s.logDigest?.slice(-1500), elapsedSec: s.elapsedSec });
      if (!["fixable", "fixable-tests"].includes(s.status) || attempt === 2) break;
      const f = json(await call("fix_and_rerun_hyperexecute", { runId: run.runId }));
      if (!f.nextRun?.runId) { rec.fixError = f.raw || JSON.stringify(f); break; }
      rec.attempts.at(-1).fixedWith = f.applied;
      run = f.nextRun;
    }
  } catch (e) {
    rec.error = e.message.slice(0, 600);
  }
  rec.final = rec.error ? "ERROR" : rec.attempts.at(-1)?.status;
  // the setup works when the tests ran and reported, whatever they found (stale samples fail on their own)
  rec.setupWorks = ["passed", "passed-with-failures", "test-failures"].includes(rec.final);
  rec.minutes = Math.round((Date.now() - t0) / 6000) / 10;
  console.log(`${String(rec.final).padEnd(22)} ${(rec.setupWorks ? "setup ok" : "setup ✗").padEnd(9)} ${c.name.padEnd(40)} ${rec.framework || ""} ${rec.attempts.map((a) => a.status).join(" → ")} ${rec.minutes}m ${rec.attempts.at(-1)?.jobUrl || rec.error || ""}`);
  return rec;
}

const results = [];
const queue = [...cases];
await Promise.all(Array.from({ length: parallel }, async () => { for (let c; (c = queue.shift()); ) { results.push(await one(c)); fs.writeFileSync(outFile, JSON.stringify(results, null, 2)); } }));
await client.close();
const by = results.reduce((m, r) => ((m[r.final] = (m[r.final] || 0) + 1), m), {});
console.log("\n", by, `\nreport: ${outFile}`);
