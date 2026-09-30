// Learning from use, on this machine only (~/.hyperexecute-studio):
//   preferences.json        options the user keeps choosing, per framework. After the same choice twice,
//                           it becomes the starting point for that framework (explicit options still win).
//   accuracy-cases/<repo>/  every YAML that ran green is saved as an accuracy case (case.json + expected.yaml),
//                           so `npm run accuracy` checks future versions against setups that really worked.
// HE_LEARN=off turns both off. Nothing here leaves the machine.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = () => process.env.HE_STATE_DIR || path.join(os.homedir(), ".hyperexecute-studio");
const enabled = () => !/^(off|0|false|no)$/i.test(process.env.HE_LEARN || "");
export const accuracyCasesDir = () => process.env.HE_ACCURACY_CASES || path.join(dir(), "accuracy-cases");

// Options worth learning: how people like to run. Not YAML version or mode (technical choices the rules
// make per repo), and not repo-specific commands or values.
const LEARNABLE = ["runson", "concurrency", "splitBy", "retryOnFailure", "maxRetries", "globalTimeout", "tunnel"];
const key = (profile) => `${profile.language || "?"}/${profile.primaryFramework || "?"}`;

function readPrefs() {
  try { return JSON.parse(fs.readFileSync(path.join(dir(), "preferences.json"), "utf8")); } catch { return {}; }
}

// Called when the user commits to a setup (YAML written, or a run started with it).
export function recordChoice(profile, options) {
  if (!enabled() || !profile) return;
  try {
    const prefs = readPrefs();
    const k = key(profile);
    const entry = (prefs[k] ||= {});
    for (const name of LEARNABLE) {
      if (options[name] === undefined || options[name] === null) continue;
      const v = JSON.stringify(options[name]);
      const e = (entry[name] ||= { value: v, count: 0 });
      if (e.value === v) e.count++;
      else Object.assign(e, { value: v, count: 1 }); // a different choice starts over
      e.at = new Date().toISOString();
    }
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(path.join(dir(), "preferences.json"), JSON.stringify(prefs, null, 2));
  } catch {}
}

// Options chosen the same way at least twice for this framework.
export function learnedOptions(profile) {
  if (!enabled() || !profile) return {};
  const entry = readPrefs()[key(profile)] || {};
  const out = {};
  for (const [name, e] of Object.entries(entry)) if (e.count >= 2 && LEARNABLE.includes(name)) out[name] = JSON.parse(e.value);
  return out;
}

// Apply learned options under the explicit ones; returns { options, learned } for the reply.
export function withLearned(profile, explicit = {}) {
  const learned = learnedOptions(profile);
  const applied = {};
  for (const [k, v] of Object.entries(learned)) if (explicit[k] === undefined) applied[k] = v;
  // a learned split may not exist for this repo's framework; the generator would refuse it
  return { options: { ...applied, ...explicit }, learned: applied };
}

// A job passed: keep its YAML as the expected result for this repo.
export function saveSuccessCase({ repo, yamlText, profile, jobId }) {
  if (!enabled() || !repo || !yamlText) return null;
  try {
    const name = path.basename(path.resolve(repo)).replace(/[^\w.-]+/g, "-");
    const out = path.join(accuracyCasesDir(), name);
    fs.mkdirSync(out, { recursive: true });
    // secrets filled in for the run must never be stored: keep only the references
    const clean = yamlText.replace(/^(\s*)(LT_USERNAME|LT_ACCESS_KEY):\s*(?!\$\{\{).+$/gm, (_, indent, k) => `${indent}${k}: \${{ .secrets.${k} }}`);
    fs.writeFileSync(path.join(out, "expected.yaml"), clean);
    fs.writeFileSync(path.join(out, "case.json"), JSON.stringify({ name, repo: path.resolve(repo), source: "a job that passed", framework: profile?.primaryFramework, jobId: jobId || undefined, savedAt: new Date().toISOString() }, null, 2) + "\n");
    return out;
  } catch {
    return null;
  }
}
