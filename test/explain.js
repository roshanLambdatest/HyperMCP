// Every line the generator writes (and every golden YAML) gets a line-by-line explanation,
// and the annotated copy is the same YAML. Fails when a new key is generated without one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { analyzeRepo } from "../src/analyzer.js";
import { generateYaml } from "../src/generator.js";
import { explainYamlLines, annotateYaml } from "../src/yaml-explain.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const yamls = fs.readdirSync(path.join(root, "knowledge/golden")).map((f) => [`golden/${f}`, fs.readFileSync(path.join(root, "knowledge/golden", f), "utf8")]);
for (const d of fs.readdirSync(path.join(root, "test/fixtures"))) {
  let profile;
  try { profile = analyzeRepo(path.join(root, "test/fixtures", d)); } catch { continue; }
  for (const o of [{}, { yamlVersion: "0.1" }, { executionMode: "matrix" }, { tunnel: true, retryOnFailure: true, maxRetries: 2 }]) {
    try { yamls.push([`${d} ${JSON.stringify(o)}`, generateYaml(profile, { ...o, embedCredentials: false }).yaml]); } catch {}
  }
}
const plain = (t) => JSON.stringify(YAML.parse(t.replace(/\$\{\{[^}]*\}\}/g, "x")));
let failures = 0;
for (const [name, text] of yamls) {
  const gaps = explainYamlLines(text).filter((l) => (l.kind === "key" || l.kind === "item") && (!l.what || /explainer knows|inside `/.test(l.what)));
  if (gaps.length) { failures++; console.log(`FAIL  ${name}: no explanation for ${gaps.map((g) => `line ${g.n} ${g.text.trim()}`).join("; ")}`); }
  if (plain(annotateYaml(text)) !== plain(text)) { failures++; console.log(`FAIL  ${name}: the annotated copy is a different YAML`); }
}
const unknown = explainYamlLines("version: 0.1\nbogusKey: 1\n").find((l) => l.text.startsWith("bogusKey"));
if (!/explainer knows/.test(unknown?.what)) { failures++; console.log("FAIL  an unknown key is not flagged"); }
console.log(failures ? `\n${failures} FAILED` : `\nALL PASSED (${yamls.length} YAMLs explained line by line)`);
process.exit(failures ? 1 : 0);
