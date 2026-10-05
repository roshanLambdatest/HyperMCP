// Learning from use, on this machine only (~/.hyperexecute-studio):
//   preferences.json        options the user keeps choosing, per framework. After the same choice twice,
//                           it becomes the starting point for that framework (explicit options still win).
//   accuracy-cases/<repo>/  every YAML that ran green is saved as an accuracy case (case.json + expected.yaml),
//                           so `npm run accuracy` checks future versions against setups that really worked.
//   learned-fixes.json      a failure, and the YAML change after which the next run passed. The same failure
//                           later gets that change suggested first (also shared through team memory).
// HE_LEARN=off turns both off. Nothing here leaves the machine.
//
// Team memory, in the tested repo (.hyperexecute/team.json), shared through git and reviewed like code:
//   options        settings the team agreed on for this repo (OS, VMs, split, profile, env values…)
//   notes          things every teammate's agent should know ("staging needs the tunnel")
//   passingSetups  the last setups that ran green
//   fixesThatWorked  failures the team fixed, with the YAML change that made the next run pass. One that
//                    worked twice is suggested for promotion; once promoted (remember_for_team promoteFix) it
//                    is applied when generating for the same framework and language, until a run fails on it.
// Precedence when generating: explicit options > team options > this user's usual settings.
// HE_TEAM_MEMORY=off turns it off. Credentials are never written to it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { mask, maskKeepRefs, signature } from "./feedback.js";

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

// ---------- team memory ----------

export const TEAM_FILE = path.join(".hyperexecute", "team.json");
const teamEnabled = () => !/^(off|0|false|no)$/i.test(process.env.HE_TEAM_MEMORY || "");
// Options a team may pin for a repo: the learnable ones plus repo facts. Never credentials.
export const TEAM_OPTIONS = [...LEARNABLE, "yamlVersion", "executionMode", "mavenProfile", "runnerClass", "tags", "extraEnv", "jobLabel", "discoveryMode", "outputFileName"];
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD/i;

function cleanTeamOptions(options = {}) {
  const out = {};
  for (const [k, v] of Object.entries(options)) {
    if (!TEAM_OPTIONS.includes(k) || v === undefined || v === null) continue;
    if (k === "extraEnv" && v && typeof v === "object") {
      // env values are shared in git: keep secret-looking ones only as ${{ .secrets.X }} references
      const env = Object.fromEntries(Object.entries(v).filter(([n, val]) => !SECRET_NAME.test(n) || /^\$\{\{\s*\.secrets\./.test(String(val))));
      if (Object.keys(env).length) out[k] = env;
      continue;
    }
    out[k] = v;
  }
  return out;
}

export function readTeamMemory(repo) {
  if (!teamEnabled() || !repo) return null;
  try {
    const t = JSON.parse(fs.readFileSync(path.join(repo, TEAM_FILE), "utf8"));
    const list = (x) => (Array.isArray(x) ? x : []);
    return { options: cleanTeamOptions(t.options), notes: list(t.notes).filter((n) => typeof n === "string"), passingSetups: list(t.passingSetups), fixesThatWorked: list(t.fixesThatWorked) };
  } catch {
    return null;
  }
}

function writeTeamMemory(repo, t) {
  const file = path.join(repo, TEAM_FILE);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = {
    about: "HyperExecute Studio team memory: settings and notes every teammate's agent uses for this repo. Commit it; review changes like code.",
    options: t.options,
    notes: t.notes,
    passingSetups: t.passingSetups,
    fixesThatWorked: t.fixesThatWorked?.length ? t.fixesThatWorked : undefined,
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}

// Explicit "remember this for the team": set/unset options, add/remove notes.
export function rememberForTeam(repo, { options, unset, note, removeNote } = {}) {
  if (!teamEnabled()) throw new Error("Team memory is off (HE_TEAM_MEMORY=off).");
  const t = readTeamMemory(repo) || { options: {}, notes: [], passingSetups: [], fixesThatWorked: [] };
  const rejected = Object.keys(options || {}).filter((k) => !(k in cleanTeamOptions({ [k]: options[k] })));
  Object.assign(t.options, cleanTeamOptions(options));
  if (options?.extraEnv) {
    const dropped = Object.keys(options.extraEnv).filter((n) => !(n in (t.options.extraEnv || {})));
    if (dropped.length) rejected.push(...dropped.map((n) => `extraEnv.${n} (secret: use \${{ .secrets.${n} }})`));
  }
  for (const k of unset || []) delete t.options[k];
  if (note && !t.notes.includes(note.trim())) t.notes.push(note.trim());
  if (removeNote) t.notes = t.notes.filter((n) => n !== removeNote && !n.toLowerCase().includes(String(removeNote).toLowerCase()));
  return { file: writeTeamMemory(repo, t), memory: t, rejected };
}

// A job passed: the team's options follow what ran green, and the setup is listed.
export function recordTeamPass(repo, { options, configFile, jobId, framework } = {}) {
  if (!enabled() || !teamEnabled() || !repo) return null;
  try {
    const t = readTeamMemory(repo) || { options: {}, notes: [], passingSetups: [], fixesThatWorked: [] };
    for (const [k, v] of Object.entries(cleanTeamOptions(options))) if (LEARNABLE.includes(k)) t.options[k] = v;
    t.passingSetups = [{ config: configFile, framework, jobId: jobId || undefined, at: new Date().toISOString() }, ...t.passingSetups].slice(0, 10);
    return writeTeamMemory(repo, t);
  } catch {
    return null;
  }
}

// ---------- fixes that worked ----------

// What changed in the YAML, line by line, without secrets.
export function yamlChange(before = "", after = "") {
  const clean = (l) => maskKeepRefs(l.replace(/^(\s*(LT_USERNAME|LT_ACCESS_KEY):\s*)(?!\$\{\{).+$/, "$1<masked>"));
  const a = String(before).split("\n"), b = String(after).split("\n");
  const inA = new Set(a), inB = new Set(b);
  return {
    removed: a.filter((l) => l.trim() && !inB.has(l)).slice(0, 30).map(clean),
    added: b.filter((l) => l.trim() && !inA.has(l)).slice(0, 30).map(clean),
  };
}

// The same failure: same headline (normalized), or the same set of rules matched.
const failureKey = (f) => ({ sig: f?.headline ? signature(f.headline) : null, rules: [...new Set(f?.ruleIds || [])].sort().join(",") });
const sameFailure = (k, e) => (k.sig && e.sig === k.sig) || (k.rules && e.rules === k.rules);
const fixesFile = () => path.join(dir(), "learned-fixes.json");
const readFixes = () => { try { return JSON.parse(fs.readFileSync(fixesFile(), "utf8")); } catch { return []; } };

// A run passed after a fix: remember the failure and the change (here and in the repo's team memory).
export function recordFixThatWorked({ repo, failure, before, after, how, applied, profile, jobId }) {
  if (!enabled() || !failure) return null;
  const k = failureKey(failure);
  if (!k.sig && !k.rules) return null;
  const change = yamlChange(before, after);
  if (!change.added.length && !change.removed.length) return null;
  const entry = { ...k, headline: mask(failure.headline || "").slice(0, 300), title: failure.title, how, applied: applied?.slice(0, 10), change, patch: yamlPatch(before, after), framework: profile?.primaryFramework, language: profile?.language, jobId: jobId || undefined };
  try {
    const all = readFixes();
    const old = all.find((e) => sameFailure(k, e));
    const now = new Date().toISOString();
    if (old) Object.assign(old, entry, { worked: (old.worked || 1) + 1, lastAt: now });
    else all.unshift({ ...entry, worked: 1, firstAt: now, lastAt: now });
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(fixesFile(), JSON.stringify(all.slice(0, 200), null, 2));
  } catch {}
  if (teamEnabled() && repo) {
    try {
      const t = readTeamMemory(repo) || { options: {}, notes: [], passingSetups: [], fixesThatWorked: [] };
      const rest = t.fixesThatWorked.filter((e) => !sameFailure(k, e));
      const prev = t.fixesThatWorked.find((e) => sameFailure(k, e));
      t.fixesThatWorked = [{ ...entry, worked: (prev?.worked || 0) + 1, at: new Date().toISOString(), promoted: prev?.promoted, stoppedWorking: prev?.stoppedWorking }, ...rest].slice(0, 20);
      writeTeamMemory(repo, t);
    } catch {}
  }
  return entry;
}

// Has this failure been fixed before? The team's record first (it travels with the repo), then this machine's.
export function findLearnedFix({ repo, headline, ruleIds }) {
  if (!enabled()) return null;
  const k = failureKey({ headline, ruleIds });
  if (!k.sig && !k.rules) return null;
  const team = readTeamMemory(repo)?.fixesThatWorked?.find((e) => sameFailure(k, e));
  if (team) return { ...team, from: "team" };
  const mine = readFixes().find((e) => sameFailure(k, e));
  return mine ? { ...mine, from: "this machine" } : null;
}

// ---------- promoted team fixes ----------

// The same change as data, top-level key by key, so it can be applied to a newly generated YAML.
// Lists keep their order: each added item remembers the item it came before. Secrets are never kept.
const SKIP_KEYS = new Set(["version"]);
export function yamlPatch(before = "", after = "") {
  const parse = (t) => { try { return YAML.parse(String(t)) || {}; } catch { return null; } };
  const a = parse(before), b = parse(after);
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return [];
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (SKIP_KEYS.has(k) || same(a[k], b[k])) continue;
    if (Array.isArray(a[k]) && Array.isArray(b[k]) && b[k].every((x) => typeof x === "string")) {
      const add = b[k].map((item, i) => ({ item, before: b[k].slice(i + 1).find((n) => a[k].includes(n)) })).filter((x) => !a[k].includes(x.item));
      out.push({ key: k, add, remove: a[k].filter((x) => !b[k].includes(x)) });
    } else if (k === "env" && b.env && typeof b.env === "object") {
      const set = Object.fromEntries(Object.entries(b.env).filter(([n, v]) => !SECRET_NAME.test(n) && !/^LT_/.test(n) && !same(v, a.env?.[n])));
      if (Object.keys(set).length) out.push({ key: "env", set });
    } else if (!(k in b)) out.push({ key: k, unset: true });
    else if (!SECRET_NAME.test(k)) out.push({ key: k, value: b[k] });
  }
  return out;
}

const fixId = (e) => (e.sig || e.rules || "").slice(0, 80);
const fixLabel = (f) => (f.patch || []).map((p) => p.add?.length ? p.add.map((x) => `Added \`${x.item}\` to ${p.key}`).join("; ") : p.remove?.length ? `Removed \`${p.remove.join("`, `")}\` from ${p.key}` : p.set ? `Set env ${Object.keys(p.set).join(", ")}` : p.unset ? `Removed ${p.key}` : `Set ${p.key}: ${JSON.stringify(p.value)}`).join("; ");
// generator options and the YAML keys they decide: an explicit option beats a team fix on those keys
const OPTION_KEYS = { runson: ["runson"], concurrency: ["concurrency"], retryOnFailure: ["retryOnFailure"], maxRetries: ["maxRetries"], globalTimeout: ["globalTimeout", "testSuiteTimeout", "testSuiteStep"], tunnel: ["tunnel", "tunnelOpts"], extraEnv: ["env"], yamlVersion: ["framework", "testDiscovery", "testRunnerCommand"], executionMode: ["autosplit", "matrix", "testSuites"], runnerCommand: ["testRunnerCommand"], discoveryCommand: ["testDiscovery"], includeRuntime: ["runtime"] };
const matches = (f, profile) => f.framework === profile?.primaryFramework && f.language === profile?.language;

// Team fixes that worked at least twice and nobody promoted yet: suggest them.
export function promotionCandidates(repo, profile) {
  return (readTeamMemory(repo)?.fixesThatWorked || []).filter((f) => (f.worked || 0) >= 2 && !f.promoted && f.patch?.length && (!profile || matches(f, profile)))
    .map((f) => ({ promoteFix: fixId(f), worked: f.worked, change: fixLabel(f), failure: f.headline || f.title, how: `remember_for_team with promoteFix: "${fixId(f)}" applies it to every new YAML for ${f.framework} (${f.language})` }));
}

// Promote (or re-enable) a team fix so generation applies it.
export function promoteTeamFix(repo, id) {
  const t = readTeamMemory(repo);
  const f = t?.fixesThatWorked.find((e) => fixId(e) === id || e.headline === id);
  if (!f) throw new Error(`No team fix "${id}" in ${TEAM_FILE}.`);
  if (!f.patch?.length) throw new Error("That fix has no change that can be applied to a new YAML.");
  f.promoted = new Date().toISOString().slice(0, 10);
  delete f.stoppedWorking;
  writeTeamMemory(repo, t);
  return { promoted: fixId(f), change: fixLabel(f), framework: f.framework, language: f.language, worked: f.worked };
}

// Apply the promoted team fixes for this framework and language to a generated YAML, after the normal rules.
// Returns { yaml, applied: [labels], skipped: [labels] }. A fix that adds a validation error (`isValid` false) is skipped.
export function applyTeamFixes(yamlText, profile, repo, explicit = {}, isValid = () => true) {
  const fixes = (readTeamMemory(repo)?.fixesThatWorked || []).filter((f) => f.promoted && !f.stoppedWorking && f.patch?.length && matches(f, profile));
  const applied = [], skipped = [];
  let text = yamlText;
  for (const f of fixes) {
    const label = `${fixLabel(f)} (team fix, worked ${f.worked}×)`;
    const owner = Object.keys(explicit).find((o) => (OPTION_KEYS[o] || []).some((k) => f.patch.some((p) => p.key === k)));
    if (owner) { skipped.push(`${label}: skipped, you set ${owner}`); continue; }
    const doc = YAML.parseDocument(text);
    let changed = false;
    for (const p of f.patch) {
      if (p.add || p.remove) {
        const list = doc.get(p.key);
        if (list && !YAML.isSeq(list)) continue;
        const seq = list || doc.createNode([]);
        for (const r of p.remove || []) { const i = seq.items.findIndex((n) => String(n.value ?? n) === r); if (i >= 0) { seq.items.splice(i, 1); changed = true; } }
        for (const { item, before } of p.add || []) {
          if (seq.items.some((n) => String(n.value ?? n) === item)) continue;
          const at = before === undefined ? -1 : seq.items.findIndex((n) => String(n.value ?? n) === before);
          seq.items.splice(at < 0 ? seq.items.length : at, 0, doc.createNode(item));
          changed = true;
        }
        if (!list && seq.items.length) doc.set(p.key, seq);
      } else if (p.set) {
        for (const [n, v] of Object.entries(p.set)) if (JSON.stringify(doc.getIn([p.key, n])) !== JSON.stringify(v)) { doc.setIn([p.key, n], v); changed = true; }
      } else if (p.unset) { if (doc.has(p.key)) { doc.delete(p.key); changed = true; } }
      else if (JSON.stringify(doc.get(p.key)) !== JSON.stringify(p.value)) { doc.set(p.key, p.value); changed = true; }
    }
    if (!changed) continue;
    const next = doc.toString({ lineWidth: 0 });
    if (!isValid(next)) { skipped.push(`${label}: skipped, it would make the YAML invalid`); continue; }
    text = next;
    applied.push(label);
  }
  return { yaml: text, applied, skipped };
}

// A run failed on what a promoted fix added: stop applying it (remember_for_team promoteFix re-enables it).
export function markStoppedTeamFixes(repo, failureText = "") {
  const t = readTeamMemory(repo);
  if (!t || !failureText) return [];
  const stopped = [];
  for (const f of t.fixesThatWorked) {
    if (!f.promoted || f.stoppedWorking) continue;
    const added = (f.patch || []).flatMap((p) => [...(p.add || []).map((x) => x.item), ...(p.set ? Object.values(p.set).map(String) : []), ...(p.value !== undefined && typeof p.value !== "object" ? [String(p.value)] : [])]);
    if (added.some((a) => a.length >= 6 && failureText.includes(a))) { f.stoppedWorking = new Date().toISOString().slice(0, 10); stopped.push(fixLabel(f)); }
  }
  if (stopped.length) writeTeamMemory(repo, t);
  return stopped;
}

// This machine's fixes for the same framework and language: listed, never applied.
export function personalFixSuggestions(profile) {
  if (!enabled()) return [];
  return readFixes().filter((f) => matches(f, profile)).slice(0, 3).map((f) => ({ failure: f.headline || f.title, worked: f.worked, change: f.change }));
}

// ---------- this user's usual settings ----------

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

// Apply team and learned options under the explicit ones; returns { options, learned, team } for the reply.
// With a repo, the team's options for it sit between the explicit ones and this user's usual settings.
export function withLearned(profile, explicit = {}, repo) {
  const teamOpts = readTeamMemory(repo)?.options || {};
  const team = {};
  for (const [k, v] of Object.entries(teamOpts)) if (explicit[k] === undefined) team[k] = v;
  const applied = {};
  for (const [k, v] of Object.entries(learnedOptions(profile))) if (explicit[k] === undefined && team[k] === undefined) applied[k] = v;
  // a learned split may not exist for this repo's framework; the generator would refuse it
  return { options: { ...applied, ...team, ...explicit }, learned: applied, team };
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
