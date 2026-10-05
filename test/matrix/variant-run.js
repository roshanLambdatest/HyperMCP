// Run hand-edited YAML variants of one repo for real (to compare what HyperExecute accepts).
//   node test/matrix/variant-run.js <repo> <name>=<yaml-file> [<name>=<yaml-file> …]
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [repo, ...variants] = process.argv.slice(2);
const here = path.dirname(new URL(import.meta.url).pathname);
const client = new Client({ name: "variants", version: "1" });
await client.connect(new StdioClientTransport({ command: "node", args: [path.join(here, "..", "..", "src", "index.js")], env: { ...process.env, HE_LEARN: "off", HE_GISTS: "off", HE_DOCS: "off" } }));
const call = async (name, a) => JSON.parse((await client.callTool({ name, arguments: a }, undefined, { timeout: 600000 })).content[0].text);
await Promise.all(variants.map(async (v) => {
  const [name, file] = v.split("=");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `he-var-${name}-`));
  fs.cpSync(repo, dir, { recursive: true, filter: (s) => !/[\\/](\.git|node_modules|target)$/.test(s) });
  fs.copyFileSync(file, path.join(dir, "hyperexecute.yaml"));
  let r;
  try { r = await call("run_hyperexecute_job", { repoPath: dir }); } catch (e) { console.log(name, "run error", e.message); return; }
  let s;
  do { s = await call("get_hyperexecute_run", { runId: r.runId, waitSeconds: 60 }); } while (s.status === "running");
  console.log(`${name.padEnd(12)} ${s.status.padEnd(18)} tests ${s.diagnosis?.tests?.passed ?? "?"}/${s.diagnosis?.tests?.total ?? "?"} disc ${JSON.stringify({ found: s.discoveryCheck?.platformDiscovered, ran: s.discoveryCheck?.executedTests, verdict: s.discoveryCheck?.verdict })} ${s.jobUrl} dir=${dir}`);
}));
await client.close();
