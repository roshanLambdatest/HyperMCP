// Every line the generator writes (and every golden YAML) gets a line-by-line explanation,
// and the annotated copy is the same YAML. Fails when a new key is generated without one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { analyzeRepo } from "../src/analyzer.js";
import { generateYaml } from "../src/generator.js";
import { explainYamlLines, annotateYaml } from "../src/yaml-explain.js";
import { locateYamlMessage, yamlMessageFixes } from "../src/yaml-problems.js";
import { validateYaml } from "../src/validator.js";

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
// problems land on the line they're about, and each quick fix removes its problem
const broken = {
  "version: 0.1\nrunson: windows\nautosplit: true\nconcurency: 4\nmaxRetries: 2\ntestDiscovery:\n  type: raw\n  mode: remote\n  command: ls\ntestRunnerCommand: run $test\npre:\n  - npm ci\n": { 'runson "windows"': 2, "concurency": 4, "maxRetries": 5 },
  'version: "0.2"\nrunson: linux\nautosplit: true\nconcurrency: 2\npre:\n  - mvn dependency:resolve\ntestDiscovery:\n  type: raw\n  mode: remote\n  command: ls\nframework:\n  name: maven/testng\n': { "must NOT contain testDiscovery": 7 },
  "version: 0.1\nrunson: linux\ntestDiscovery:\n\ttype: raw\n": { "Tabs": 4 },
};
const applyFix = (text, fix) => {
  const L = text.split("\n");
  for (const e of [...fix.edits].sort((a, b) => (b.line || b.from) - (a.line || a.from))) {
    if (e.remove) L.splice(e.from - 1, e.to - e.from + 1);
    else if (e.insert !== undefined) L.splice(e.line - 1, 0, e.insert);
    else L[e.line - 1] = e.text;
  }
  return L.join("\n");
};
let fixesChecked = 0;
for (const [text, expect] of Object.entries(broken)) {
  const v = validateYaml(text);
  for (const [needle, line] of Object.entries(expect)) {
    const m = [...v.errors, ...v.warnings].find((x) => x.includes(needle));
    if (!m) { failures++; console.log(`FAIL  no message containing "${needle}"`); continue; }
    if (locateYamlMessage(text, m) !== line) { failures++; console.log(`FAIL  "${needle}" located on line ${locateYamlMessage(text, m)}, expected ${line}`); }
    for (const f of yamlMessageFixes(text, m)) {
      fixesChecked++;
      const after = validateYaml(applyFix(text, f));
      if ([...after.errors, ...after.warnings].includes(m)) { failures++; console.log(`FAIL  fix "${f.title}" leaves "${needle}"`); }
    }
  }
}
if (fixesChecked < 5) { failures++; console.log(`FAIL  only ${fixesChecked} quick fixes offered`); }
console.log(failures ? `\n${failures} FAILED` : `\nALL PASSED (${yamls.length} YAMLs explained line by line)`);
process.exit(failures ? 1 : 0);
