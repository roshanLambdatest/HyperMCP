// Learning from use, on this machine only (~/.hyperexecute-studio):
//   preferences.json        options the user keeps choosing, per framework. After the same choice twice,
//                           it becomes the starting point for that framework (explicit options still win).
//   accuracy-cases/<repo>/  every YAML that ran green is saved as an accuracy case (case.json + expected.yaml),
//                           so `npm run accuracy` checks future versions against setups that really worked.
// HE_LEARN=off turns both off. Nothing here leaves the machine.
//
// Team memory, in the tested repo (.hyperexecute/team.json), shared through git and reviewed like code:
//   options        settings the team agreed on for this repo (OS, VMs, split, profile, env values…)
//   notes          things every teammate's agent should know ("staging needs the tunnel")
//   passingSetups  the last setups that ran green
// Precedence when generating: explicit options > team options > this user's usual settings.
// HE_TEAM_MEMORY=off turns it off. Credentials are never written to it.

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
    return { options: cleanTeamOptions(t.options), notes: Array.isArray(t.notes) ? t.notes.filter((n) => typeof n === "string") : [], passingSetups: Array.isArray(t.passingSetups) ? t.passingSetups : [] };
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
  };
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n");
  return file;
}

// Explicit "remember this for the team": set/unset options, add/remove notes.
export function rememberForTeam(repo, { options, unset, note, removeNote } = {}) {
  if (!teamEnabled()) throw new Error("Team memory is off (HE_TEAM_MEMORY=off).");
  const t = readTeamMemory(repo) || { options: {}, notes: [], passingSetups: [] };
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
    const t = readTeamMemory(repo) || { options: {}, notes: [], passingSetups: [] };
    for (const [k, v] of Object.entries(cleanTeamOptions(options))) if (LEARNABLE.includes(k)) t.options[k] = v;
    t.passingSetups = [{ config: configFile, framework, jobId: jobId || undefined, at: new Date().toISOString() }, ...t.passingSetups].slice(0, 10);
    return writeTeamMemory(repo, t);
  } catch {
    return null;
  }
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
